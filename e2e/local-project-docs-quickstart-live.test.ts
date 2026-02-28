import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { nowIso, openApp } from "../src/app/context";
import { notionToken } from "../src/config/env";
import { tasks, workflows } from "../src/db/schema";
import {
  assertNoNewGlobalNotionflowWrites,
  createTempProjectFixture,
  snapshotGlobalNotionflowWrites,
  type TempProjectFixture,
} from "./helpers/projectFixture";

loadDotEnv();

const hasLiveNotionEnv = Boolean(notionToken());

describe("docs quickstart live smoke", () => {
  let fixture: TempProjectFixture | null = null;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
      fixture = null;
    }
  });

  it.skipIf(!hasLiveNotionEnv)(
    "runs init -> factory create -> doctor -> tick in local project mode",
    async () => {
      const before = await snapshotGlobalNotionflowWrites();
      fixture = await createTempProjectFixture("notionflow-docs-live-");

      await execCli(["init"], fixture.projectDir);
      await execCli(["factory", "create", "--id", "docs-live", "--skip-notion-board"], fixture.projectDir);

      await writeFile(path.join(fixture.projectDir, "notionflow.config.ts"), docsConfigSource(), "utf8");
      await writeFile(path.join(fixture.projectDir, "factories", "docs-live.ts"), docsFactorySource(), "utf8");

      const doctor = await execCli(["doctor"], fixture.projectDir);
      const resolvedProjectRoot = await realpath(fixture.projectDir);
      expect(doctor.stdout).toContain(`Project root: ${resolvedProjectRoot}`);
      expect(doctor.stdout).toContain(
        `Config path: ${path.join(resolvedProjectRoot, "notionflow.config.ts")}`,
      );

      const boardId = `docs-live-${Date.now()}`;
      await execCli(
        [
          "integrations",
          "notion",
          "provision-board",
          "--board",
          boardId,
          "--title",
          `Docs Live ${boardId}`,
        ],
        fixture.projectDir,
      );
      await ensureWorkflowRegistered(fixture.projectDir, "docs-live");

      const created = await execCli(
        [
          "integrations",
          "notion",
          "create-task",
          "--board",
          boardId,
          "--factory",
          "docs-live",
          "--title",
          "Docs quickstart live task",
          "--status",
          "queue",
        ],
        fixture.projectDir,
      );
      const taskExternalId = extractTaskExternalId(created.stdout);

      const tick = await execCli(["tick", "--board", boardId, "--factory", "docs-live"], fixture.projectDir);
      expect(tick.stdout).toContain("Sync complete");

      await execCli(["run", "--task", taskExternalId], fixture.projectDir);

      await expect(readTaskState(fixture.projectDir, taskExternalId)).resolves.toBe("done");

      const after = await snapshotGlobalNotionflowWrites();
      assertNoNewGlobalNotionflowWrites(before, after);
    },
    180_000,
  );
});

async function execCli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
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
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`Command failed (${code ?? -1}): notionflow ${args.join(" ")}\n${stderr}`));
    });
  });
}

function extractTaskExternalId(stdout: string): string {
  const match = stdout.match(/Task created:\s*([^\s]+)/);
  if (!match?.[1]) {
    throw new Error(`Unable to extract created task id from output:\n${stdout}`);
  }

  return match[1];
}

async function readTaskState(projectRoot: string, taskExternalId: string): Promise<string> {
  const { db } = await openApp({ projectRoot });
  const [task] = await db.select().from(tasks).where(eq(tasks.externalTaskId, taskExternalId));

  if (!task) {
    throw new Error(`Task not found in local DB: ${taskExternalId}`);
  }

  return task.state;
}

function docsConfigSource(): string {
  return [
    "export default {",
    "  factories: [\"./factories/docs-live.ts\"],",
    "};",
    "",
  ].join("\n");
}

function docsFactorySource(): string {
  return [
    "const complete = async ({ ctx }) => ({",
    "  status: \"done\",",
    "  data: { ...ctx, completedBy: \"docs-live\" },",
    "});",
    "",
    "export default {",
    "  id: \"docs-live\",",
    "  start: \"start\",",
    "  context: {},",
    "  states: {",
    "    start: {",
    "      type: \"action\",",
    "      agent: complete,",
    "      on: { done: \"done\", failed: \"failed\" },",
    "    },",
    "    done: { type: \"done\" },",
    "    failed: { type: \"failed\" },",
    "  },",
    "};",
    "",
  ].join("\n");
}

async function ensureWorkflowRegistered(projectRoot: string, workflowId: string): Promise<void> {
  const { db } = await openApp({ projectRoot });
  const now = nowIso();
  await db
    .insert(workflows)
    .values({
      id: workflowId,
      version: 1,
      definitionYaml: "{}",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
}

function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
