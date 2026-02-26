import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const createdHomes: string[] = [];

function runCli(args: string[], home: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [tsxBin, "src/cli.ts", ...args], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, ...env },
    encoding: "utf8",
  });
}

describe("CLI bootstrap flow", () => {
  afterEach(() => {
    for (const dir of createdHomes.splice(0, createdHomes.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses setup as the canonical bootstrap and supports a basic orchestration command", () => {
    const home = mkdtempSync(path.join(tmpdir(), "notionflow-cli-test-"));
    createdHomes.push(home);

    const setup = runCli(["setup"], home);
    expect(setup.status).toBe(0);
    expect(setup.stdout).toContain("NotionFlow workspace is ready");

    const listWorkflows = runCli(["workflow", "list"], home);
    expect(listWorkflows.status).toBe(0);
    expect(listWorkflows.stdout).toContain("No workflows configured");
  });

  it("rejects the removed init command", () => {
    const home = mkdtempSync(path.join(tmpdir(), "notionflow-cli-test-"));
    createdHomes.push(home);

    const init = runCli(["init"], home);
    const output = `${init.stdout}\n${init.stderr}`;

    expect(init.status).not.toBe(0);
    expect(output.toLowerCase()).toContain("unknown command");
  });

  it("routes Notion commands through integrations and rejects top-level notion", () => {
    const home = mkdtempSync(path.join(tmpdir(), "notionflow-cli-test-"));
    createdHomes.push(home);

    const legacy = runCli(["notion", "sync"], home);
    const legacyOutput = `${legacy.stdout}\n${legacy.stderr}`.toLowerCase();
    expect(legacy.status).not.toBe(0);
    expect(legacyOutput).toContain("unknown command");

    const namespaced = runCli(["integrations", "notion", "sync"], home);
    const namespacedOutput = `${namespaced.stdout}\n${namespaced.stderr}`;
    expect(namespaced.status).not.toBe(0);
    expect(namespacedOutput).toContain("NOTION_API_TOKEN is required");
  });

});
