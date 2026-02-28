import { mkdir, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoNewGlobalNotionflowWrites,
  createTempProjectFixture,
  snapshotGlobalNotionflowWrites,
  type TempProjectFixture,
} from "./helpers/projectFixture";

describe("local project doctor", () => {
  let fixture: TempProjectFixture | null = null;

  afterEach(async () => {
    if (!fixture) {
      return;
    }

    await fixture.cleanup();
    fixture = null;
  });

  it("discovers project config from nested directory and reports resolved paths", async () => {
    const before = await snapshotGlobalNotionflowWrites();
    fixture = await createTempProjectFixture();

    await execCli(["init"], fixture.projectDir);

    const nestedDir = path.join(fixture.projectDir, "nested", "child");
    await mkdir(nestedDir, { recursive: true });

    const canonicalProjectRoot = await realpath(fixture.projectDir);
    const doctorOutput = await execCli(["doctor"], nestedDir);
    expect(doctorOutput).toContain(`Project root: ${canonicalProjectRoot}`);
    expect(doctorOutput).toContain(`Config path: ${path.join(canonicalProjectRoot, "notionflow.config.ts")}`);

    const after = await snapshotGlobalNotionflowWrites();
    assertNoNewGlobalNotionflowWrites(before, after);
  });
});

async function execCli(args: string[], cwd: string): Promise<string> {
  const cliPath = path.resolve(process.cwd(), "src/cli.ts");

  return new Promise<string>((resolve, reject) => {
    const child = spawn("npx", ["tsx", cliPath, ...args], {
      cwd,
      stdio: "pipe",
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(`Command failed (${code ?? -1}): notionflow ${args.join(" ")}\n${stderr}`));
    });
  });
}
