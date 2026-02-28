import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoNewGlobalNotionflowWrites,
  createTempProjectFixture,
  snapshotGlobalNotionflowWrites,
  type TempProjectFixture,
} from "./helpers/projectFixture";

describe("local project factory create", () => {
  let fixture: TempProjectFixture | null = null;

  afterEach(async () => {
    if (!fixture) {
      return;
    }

    await fixture.cleanup();
    fixture = null;
  });

  it("creates factories/<id>.ts in local project context without global writes", async () => {
    const before = await snapshotGlobalNotionflowWrites();
    fixture = await createTempProjectFixture();

    await execCli(["init"], fixture.projectDir);
    await execCli(["factory", "create", "--id", "smoke", "--skip-notion-board"], fixture.projectDir);

    await expect(stat(path.join(fixture.projectDir, "factories", "smoke.ts"))).resolves.toBeTruthy();

    const after = await snapshotGlobalNotionflowWrites();
    assertNoNewGlobalNotionflowWrites(before, after);
  });
});

async function execCli(args: string[], cwd: string): Promise<void> {
  const cliPath = path.resolve(process.cwd(), "src/cli.ts");

  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["tsx", cliPath, ...args], {
      cwd,
      stdio: "pipe",
      env: process.env,
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command failed (${code ?? -1}): notionflow ${args.join(" ")}\n${stderr}`));
    });
  });
}
