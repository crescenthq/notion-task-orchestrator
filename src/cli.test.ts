import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cliEntry = path.join(repoRoot, "src", "cli.ts");
const createdHomes: string[] = [];
const createdProjects: string[] = [];

function runCli(args: string[], home: string, env: NodeJS.ProcessEnv = {}, cwd = repoRoot) {
  return spawnSync(process.execPath, [tsxBin, cliEntry, ...args], {
    cwd,
    env: { ...process.env, HOME: home, ...env },
    encoding: "utf8",
  });
}

describe("CLI bootstrap flow", () => {
  afterEach(() => {
    for (const dir of createdHomes.splice(0, createdHomes.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
    for (const dir of createdProjects.splice(0, createdProjects.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses init as the canonical bootstrap and supports a basic orchestration command", () => {
    const home = mkdtempSync(path.join(tmpdir(), "notionflow-cli-test-"));
    const project = mkdtempSync(path.join(tmpdir(), "notionflow-project-test-"));
    createdHomes.push(home);
    createdProjects.push(project);

    const init = runCli(["init"], home, {}, project);
    expect(init.status).toBe(0);
    expect(init.stdout).toContain("NotionFlow project initialized");

    const listFactories = runCli(["factory", "list"], home, {}, project);
    expect(listFactories.status).toBe(0);
    expect(listFactories.stdout).toContain("No factories configured");
  });

  it("shows deprecation guidance for the setup command", () => {
    const home = mkdtempSync(path.join(tmpdir(), "notionflow-cli-test-"));
    const project = mkdtempSync(path.join(tmpdir(), "notionflow-project-test-"));
    createdHomes.push(home);
    createdProjects.push(project);

    const init = runCli(["init"], home, {}, project);
    expect(init.status).toBe(0);

    const setup = runCli(["setup"], home, {}, project);
    const output = `${setup.stdout}\n${setup.stderr}`;
    expect(setup.status).toBe(0);
    expect(output).toContain("[deprecated]");
    expect(output).toContain("notionflow init");
    expect(output).toContain("notionflow factory create --id <name>");
    expect(output).toContain("notionflow doctor");
    expect(output).toContain("notionflow tick");
  });

  it("shows deprecation guidance for legacy config and board commands", () => {
    const home = mkdtempSync(path.join(tmpdir(), "notionflow-cli-test-"));
    const project = mkdtempSync(path.join(tmpdir(), "notionflow-project-test-"));
    createdHomes.push(home);
    createdProjects.push(project);

    const init = runCli(["init"], home, {}, project);
    expect(init.status).toBe(0);

    const configSet = runCli(
      ["config", "set", "--key", "NOTION_API_TOKEN", "--value", "test-token"],
      home,
      {},
      project,
    );
    expect(configSet.status).toBe(0);
    expect(configSet.stdout).toContain("[deprecated]");
    expect(configSet.stdout).toContain("notionflow init");

    const boardList = runCli(["board", "list"], home, {}, project);
    expect(boardList.status).toBe(0);
    expect(boardList.stdout).toContain("[deprecated]");
    expect(boardList.stdout).toContain("notionflow tick");
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
