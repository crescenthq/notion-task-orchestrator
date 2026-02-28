import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { nowIso, openApp } from "../src/app/context";
import { boards, tasks, workflows } from "../src/db/schema";
import {
  assertNoNewGlobalNotionflowWrites,
  createTempProjectFixture,
  snapshotGlobalNotionflowWrites,
  type TempProjectFixture,
} from "./helpers/projectFixture";

describe("local project run command", () => {
  let fixture: TempProjectFixture | null = null;

  afterEach(async () => {
    if (!fixture) {
      return;
    }

    await fixture.cleanup();
    fixture = null;
  });

  it("loads factories directly from project config and picks up edits without install", async () => {
    const before = await snapshotGlobalNotionflowWrites();
    fixture = await createTempProjectFixture();

    await execCli(["init"], fixture.projectDir);

    const factoryPath = path.join(fixture.projectDir, "factories", "smoke.ts");
    await writeFile(factoryPath, factorySource("done"), "utf8");
    await writeFile(path.join(fixture.projectDir, "notionflow.config.ts"), configSource("./factories/smoke.ts"), "utf8");

    const externalTaskId = `task-${crypto.randomUUID()}`;
    await insertQueuedTask(fixture.projectDir, externalTaskId, "smoke");

    await execCli(["run", "--task", externalTaskId], fixture.projectDir);
    await expect(readTaskState(fixture.projectDir, externalTaskId)).resolves.toBe("done");

    await writeFile(factoryPath, factorySource("failed"), "utf8");
    await resetTaskToQueued(fixture.projectDir, externalTaskId);

    await execCli(["run", "--task", externalTaskId], fixture.projectDir);
    await expect(readTaskState(fixture.projectDir, externalTaskId)).resolves.toBe("failed");

    const after = await snapshotGlobalNotionflowWrites();
    assertNoNewGlobalNotionflowWrites(before, after);
  });

  it("does not expose the removed factory install command", async () => {
    fixture = await createTempProjectFixture();
    const result = await execCliResult(["factory", "install", "--path", "./fake.ts"], fixture.projectDir);
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`.toLowerCase()).toContain("unknown command");
  });
});

async function execCli(args: string[], cwd: string): Promise<void> {
  const result = await execCliResult(args, cwd);
  if (result.code === 0) {
    return;
  }

  throw new Error(`Command failed (${result.code ?? -1}): notionflow ${args.join(" ")}\n${result.stderr}`);
}

async function execCliResult(
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const cliPath = path.resolve(process.cwd(), "src/cli.ts");
  return new Promise((resolve, reject) => {
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
      resolve({ code, stdout, stderr });
    });
  });
}

async function insertQueuedTask(projectRoot: string, externalTaskId: string, workflowId: string): Promise<void> {
  const { db } = await openApp({ projectRoot });
  const timestamp = nowIso();

  await db
    .insert(boards)
    .values({
      id: "local-board",
      adapter: "local",
      externalId: "local-board",
      configJson: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoNothing();

  await db
    .insert(workflows)
    .values({
      id: workflowId,
      version: 1,
      definitionYaml: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoNothing();

  await db.insert(tasks).values({
    id: crypto.randomUUID(),
    boardId: "local-board",
    externalTaskId,
    workflowId,
    state: "queued",
    currentStepId: null,
    stepVarsJson: null,
    waitingSince: null,
    lockToken: null,
    lockExpiresAt: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

async function readTaskState(projectRoot: string, externalTaskId: string): Promise<string> {
  const { db } = await openApp({ projectRoot });
  const [task] = await db.select().from(tasks).where(eq(tasks.externalTaskId, externalTaskId));
  if (!task) {
    throw new Error(`Task not found: ${externalTaskId}`);
  }

  return task.state;
}

async function resetTaskToQueued(projectRoot: string, externalTaskId: string): Promise<void> {
  const { db } = await openApp({ projectRoot });
  await db
    .update(tasks)
    .set({
      state: "queued",
      currentStepId: null,
      stepVarsJson: null,
      lockToken: null,
      lockExpiresAt: null,
      lastError: null,
      waitingSince: null,
      updatedAt: nowIso(),
    })
    .where(eq(tasks.externalTaskId, externalTaskId));
}

function factorySource(resultState: "done" | "failed"): string {
  return [
    `const action = async () => ({ status: ${JSON.stringify(resultState)}, data: {} });`,
    "",
    "export default {",
    "  id: \"smoke\",",
    "  start: \"start\",",
    "  context: {},",
    "  states: {",
    "    start: {",
    "      type: \"action\",",
    "      agent: action,",
    "      on: { done: \"done\", failed: \"failed\" },",
    "    },",
    "    done: { type: \"done\" },",
    "    failed: { type: \"failed\" },",
    "  },",
    "};",
    "",
  ].join("\n");
}

function configSource(factoryPath: string): string {
  return [
    "export default {",
    `  factories: [${JSON.stringify(factoryPath)}],`,
    "};",
    "",
  ].join("\n");
}
