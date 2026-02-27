import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { and, asc, desc, eq } from "drizzle-orm";
import { nowIso, openApp } from "../../src/app/context";
import { notionToken } from "../../src/config/env";
import { replayTransitionEvents } from "../../src/core/transitionEvents";
import { runs, tasks, transitionEvents } from "../../src/db/schema";
import { notionPostComment, notionAppendTaskPageLog, notionUpdateTaskPageState } from "../../src/services/notion";

type TaskRow = typeof tasks.$inferSelect;
type TransitionEventRow = typeof transitionEvents.$inferSelect;
type RunRow = typeof runs.$inferSelect;

type ScenarioArtifact = {
  scenario: string;
  factoryId: string;
  taskExternalId: string;
  taskId: string;
  runId: string | null;
  finalState: string;
  transitionCount: number;
  tickTimeline: Array<{ tickId: string; transitions: number }>;
  replayTerminalState: string | null;
  startedAt: string;
  finishedAt: string;
  notes: string[];
};

function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;

  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function isoStamp(input = new Date()): string {
  const y = input.getUTCFullYear();
  const m = String(input.getUTCMonth() + 1).padStart(2, "0");
  const d = String(input.getUTCDate()).padStart(2, "0");
  const hh = String(input.getUTCHours()).padStart(2, "0");
  const mm = String(input.getUTCMinutes()).padStart(2, "0");
  const ss = String(input.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

async function execCli(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["tsx", "src/cli.ts", ...args], {
      cwd: path.resolve(process.cwd()),
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed (${code ?? -1}): notionflow ${args.join(" ")}`));
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function createTaskAndReadNewExternalId(
  boardId: string,
  factoryId: string,
  title: string,
): Promise<string> {
  const { db } = await openApp();
  const before = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.boardId, boardId), eq(tasks.workflowId, factoryId)));
  const beforeIds = new Set(before.map((row) => row.id));

  await execCli([
    "integrations",
    "notion",
    "create-task",
    "--board",
    boardId,
    "--title",
    title,
    "--factory",
    factoryId,
    "--status",
    "queue",
  ]);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const after = await db
      .select({ id: tasks.id, externalTaskId: tasks.externalTaskId, createdAt: tasks.createdAt })
      .from(tasks)
      .where(and(eq(tasks.boardId, boardId), eq(tasks.workflowId, factoryId)))
      .orderBy(desc(tasks.createdAt));

    const created = after.find((row) => !beforeIds.has(row.id));
    if (created?.externalTaskId) return created.externalTaskId;
    await sleep(300);
  }

  throw new Error(`Unable to detect newly created task for board=${boardId} factory=${factoryId}`);
}

async function fetchTaskWithArtifacts(taskExternalId: string): Promise<{
  task: TaskRow;
  run: RunRow | null;
  events: TransitionEventRow[];
}> {
  const { db } = await openApp();
  const [task] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.externalTaskId, taskExternalId))
    .orderBy(desc(tasks.updatedAt));

  if (!task) throw new Error(`Task not found in local DB: ${taskExternalId}`);

  const [run] = await db
    .select()
    .from(runs)
    .where(eq(runs.taskId, task.id))
    .orderBy(desc(runs.startedAt));

  const events = await db
    .select()
    .from(transitionEvents)
    .where(eq(transitionEvents.taskId, task.id))
    .orderBy(asc(transitionEvents.timestamp), asc(transitionEvents.id));

  return { task, run: run ?? null, events };
}

function buildTickTimeline(events: TransitionEventRow[]): Array<{ tickId: string; transitions: number }> {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.tickId, (counts.get(event.tickId) ?? 0) + 1);
  }
  return [...counts.entries()].map(([tickId, transitions]) => ({ tickId, transitions }));
}

async function runTick(boardId: string, factoryId: string, maxTransitionsPerTick?: number): Promise<void> {
  const args = ["tick", "--board", boardId, "--factory", factoryId, "--run"];
  if (typeof maxTransitionsPerTick === "number") {
    args.push("--max-transitions-per-tick", String(maxTransitionsPerTick));
  }
  await execCli(args);
}

async function runSingleTask(taskExternalId: string, maxTransitionsPerTick?: number): Promise<void> {
  const args = ["run", "--task", taskExternalId];
  if (typeof maxTransitionsPerTick === "number") {
    args.push("--max-transitions-per-tick", String(maxTransitionsPerTick));
  }
  await execCli(args);
}

async function runUntilState(
  boardId: string,
  factoryId: string,
  taskExternalId: string,
  states: string[],
  options?: { maxTicks?: number; maxTransitionsPerTick?: number },
): Promise<TaskRow> {
  const maxTicks = options?.maxTicks ?? 12;

  for (let i = 0; i < maxTicks; i += 1) {
    await runTick(boardId, factoryId, options?.maxTransitionsPerTick);
    const { task } = await fetchTaskWithArtifacts(taskExternalId);
    if (states.includes(task.state)) return task;
    await sleep(500);
  }

  const { task } = await fetchTaskWithArtifacts(taskExternalId);
  throw new Error(
    `Task ${taskExternalId} did not reach states [${states.join(", ")}] within ${maxTicks} ticks (current=${task.state})`,
  );
}

async function installFactory(factoryFilePath: string, parentPage?: string): Promise<void> {
  const args = ["factory", "install", "--path", factoryFilePath];
  if (parentPage) args.push("--parent-page", parentPage);
  await execCli(args);
}

function assertTaskState(task: TaskRow, expected: string, scenario: string): void {
  if (task.state !== expected) {
    throw new Error(`Scenario ${scenario} expected final state=${expected} but got ${task.state}`);
  }
}

function summarizeScenario(
  scenario: string,
  factoryId: string,
  startedAt: string,
  finishedAt: string,
  task: TaskRow,
  run: RunRow | null,
  events: TransitionEventRow[],
  notes: string[],
): ScenarioArtifact {
  const replayState = replayTransitionEvents(events);
  if (replayState && ["done", "failed", "blocked", "feedback"].includes(task.state) && replayState !== task.state) {
    throw new Error(
      `Scenario ${scenario} replay terminal state mismatch: replay=${replayState} task.state=${task.state}`,
    );
  }

  return {
    scenario,
    factoryId,
    taskExternalId: task.externalTaskId,
    taskId: task.id,
    runId: run?.id ?? null,
    finalState: task.state,
    transitionCount: events.length,
    tickTimeline: buildTickTimeline(events),
    replayTerminalState: replayState,
    startedAt,
    finishedAt,
    notes,
  };
}

async function scenarioHappy(parentPage?: string): Promise<ScenarioArtifact> {
  const scenario = "A_happy";
  const factoryId = "verify-happy";
  const factoryPath = path.resolve("tasks/factories/verify-happy.ts");
  const startedAt = new Date().toISOString();

  await installFactory(factoryPath, parentPage);
  const taskExternalId = await createTaskAndReadNewExternalId(
    factoryId,
    factoryId,
    `A happy path ${isoStamp()}`,
  );
  const task = await runUntilState(factoryId, factoryId, taskExternalId, ["done"], { maxTicks: 6 });
  const { run, events } = await fetchTaskWithArtifacts(taskExternalId);

  assertTaskState(task, "done", scenario);
  if (events.length < 1) throw new Error("Scenario A expected at least one transition event");

  const finishedAt = new Date().toISOString();
  return summarizeScenario(scenario, factoryId, startedAt, finishedAt, task, run, events, []);
}

async function scenarioFeedback(parentPage?: string): Promise<ScenarioArtifact> {
  const scenario = "B_feedback";
  const factoryId = "verify-feedback";
  const factoryPath = path.resolve("tasks/factories/verify-feedback.ts");
  const startedAt = new Date().toISOString();

  await installFactory(factoryPath, parentPage);
  const taskExternalId = await createTaskAndReadNewExternalId(
    factoryId,
    factoryId,
    `B feedback path ${isoStamp()}`,
  );

  const paused = await runUntilState(factoryId, factoryId, taskExternalId, ["feedback"], { maxTicks: 6 });
  const token = notionToken();
  if (!token) throw new Error("NOTION_API_TOKEN is required for feedback verification");
  const feedbackMode = process.env.NOTIONFLOW_VERIFY_FEEDBACK_MODE ?? "local";
  if (feedbackMode === "notion-comment") {
    await notionPostComment(token, taskExternalId, `Automated verification feedback reply ${isoStamp()}`);
    await sleep(1500);
  } else if (feedbackMode === "local") {
    const { db } = await openApp();
    const existingCtx = paused.stepVarsJson ? JSON.parse(paused.stepVarsJson) as Record<string, unknown> : {};
    const resumedCtx = { ...existingCtx, human_feedback: "approved-by-local-resume" };
    await db
      .update(tasks)
      .set({
        state: "queued",
        stepVarsJson: JSON.stringify(resumedCtx),
        waitingSince: null,
        updatedAt: nowIso(),
      })
      .where(eq(tasks.id, paused.id));
    await notionUpdateTaskPageState(token, taskExternalId, "queued");
    await notionAppendTaskPageLog(
      token,
      taskExternalId,
      "Feedback received (local verification mode)",
      "Feedback was injected locally to resume deterministic verification.",
    );
  } else if (feedbackMode === "manual") {
    console.log(
      `Scenario B manual step required: add a human comment on task ${taskExternalId}, then press Enter to continue.`,
    );
    await new Promise<void>((resolve) => {
      process.stdin.resume();
      process.stdin.once("data", () => resolve());
    });
  } else {
    throw new Error(
      `Unsupported NOTIONFLOW_VERIFY_FEEDBACK_MODE=${feedbackMode}. Use manual|notion-comment|local`,
    );
  }

  const task = await runUntilState(factoryId, factoryId, taskExternalId, ["done"], { maxTicks: 8 });

  const { run, events } = await fetchTaskWithArtifacts(taskExternalId);
  assertTaskState(paused, "feedback", scenario);
  assertTaskState(task, "done", scenario);

  const eventNames = new Set(events.map((event) => event.event));
  if (!eventNames.has("feedback") || !eventNames.has("done")) {
    throw new Error("Scenario B expected both feedback and done transition events");
  }

  const finishedAt = new Date().toISOString();
  return summarizeScenario(
    scenario,
    factoryId,
    startedAt,
    finishedAt,
    task,
    run,
    events,
    [`feedback mode: ${feedbackMode}`],
  );
}

async function scenarioRetryFailure(parentPage?: string): Promise<ScenarioArtifact> {
  const scenario = "C_retry_failure";
  const factoryId = "verify-retry-failure";
  const factoryPath = path.resolve("tasks/factories/verify-retry-failure.ts");
  const startedAt = new Date().toISOString();

  await installFactory(factoryPath, parentPage);
  const taskExternalId = await createTaskAndReadNewExternalId(
    factoryId,
    factoryId,
    `C retry failure ${isoStamp()}`,
  );
  const task = await runUntilState(factoryId, factoryId, taskExternalId, ["failed"], { maxTicks: 4 });
  const { run, events } = await fetchTaskWithArtifacts(taskExternalId);

  assertTaskState(task, "failed", scenario);
  const exhaustedEvent = events.find((event) => event.reason === "action.failed.exhausted");
  if (!exhaustedEvent) throw new Error("Scenario C expected reason action.failed.exhausted");
  if (exhaustedEvent.attempt < 3) {
    throw new Error(`Scenario C expected exhausted attempt >= 3 but got ${exhaustedEvent.attempt}`);
  }

  const finishedAt = new Date().toISOString();
  return summarizeScenario(scenario, factoryId, startedAt, finishedAt, task, run, events, []);
}

async function scenarioLoop(parentPage?: string): Promise<ScenarioArtifact> {
  const scenario = "D_bounded_loop";
  const factoryId = "verify-loop";
  const factoryPath = path.resolve("tasks/factories/verify-loop.ts");
  const startedAt = new Date().toISOString();

  await installFactory(factoryPath, parentPage);
  const taskExternalId = await createTaskAndReadNewExternalId(
    factoryId,
    factoryId,
    `D bounded loop ${isoStamp()}`,
  );
  const task = await runUntilState(factoryId, factoryId, taskExternalId, ["done", "failed"], { maxTicks: 4 });
  const { run, events } = await fetchTaskWithArtifacts(taskExternalId);

  assertTaskState(task, "done", scenario);
  const hasLoopIteration = events.some((event) => event.loopIteration > 0);
  if (!hasLoopIteration) throw new Error("Scenario D expected loopIteration metadata in transition events");

  const finishedAt = new Date().toISOString();
  return summarizeScenario(scenario, factoryId, startedAt, finishedAt, task, run, events, []);
}

async function scenarioResumeReplay(parentPage?: string): Promise<ScenarioArtifact> {
  const scenario = "E_resume_replay";
  const factoryId = "verify-resume-budget";
  const factoryPath = path.resolve("tasks/factories/verify-resume-budget.ts");
  const startedAt = new Date().toISOString();

  await installFactory(factoryPath, parentPage);
  const taskExternalId = await createTaskAndReadNewExternalId(
    factoryId,
    factoryId,
    `E resume replay ${isoStamp()}`,
  );

  for (let i = 0; i < 8; i += 1) {
    await runSingleTask(taskExternalId, 1);
    const { task } = await fetchTaskWithArtifacts(taskExternalId);
    if (task.state === "done") break;
  }

  const { task, run, events } = await fetchTaskWithArtifacts(taskExternalId);
  assertTaskState(task, "done", scenario);

  const expectedPath = [
    "step_one->step_two",
    "step_two->step_three",
    "step_three->done",
  ];
  const actualPath = events.map((event) => `${event.fromStateId}->${event.toStateId}`);
  if (actualPath.length !== expectedPath.length || actualPath.some((value, idx) => value !== expectedPath[idx])) {
    throw new Error(
      `Scenario E expected exact transition path ${expectedPath.join(", ")} but got ${actualPath.join(", ")}`,
    );
  }

  const distinctTicks = new Set(events.map((event) => event.tickId));
  if (distinctTicks.size < 3) {
    throw new Error(`Scenario E expected >=3 tick IDs with maxTransitionsPerTick=1 but got ${distinctTicks.size}`);
  }

  const finishedAt = new Date().toISOString();
  return summarizeScenario(
    scenario,
    factoryId,
    startedAt,
    finishedAt,
    task,
    run,
    events,
    ["maxTransitionsPerTick=1", "replay path exact-match"],
  );
}

async function main(): Promise<void> {
  loadDotEnv();
  const parentPage = process.env.NOTION_WORKSPACE_PAGE_ID ?? process.env.NOTIONFLOW_VERIFY_PARENT_PAGE_ID;
  const runStartedAt = new Date();

  if (!notionToken()) {
    throw new Error("NOTION_API_TOKEN is required to run live factory verification");
  }

  console.log("Running live Notion verification scenarios...");
  const artifacts: ScenarioArtifact[] = [];

  artifacts.push(await scenarioHappy(parentPage));
  artifacts.push(await scenarioFeedback(parentPage));
  artifacts.push(await scenarioRetryFailure(parentPage));
  artifacts.push(await scenarioLoop(parentPage));
  artifacts.push(await scenarioResumeReplay(parentPage));

  const summary = {
    generatedAt: new Date().toISOString(),
    durationSeconds: Math.floor((Date.now() - runStartedAt.getTime()) / 1000),
    passedScenarios: artifacts.length,
    artifacts,
  };

  const stamp = isoStamp(runStartedAt);
  const outDir = path.resolve("tasks/artifacts");
  await mkdir(outDir, { recursive: true });
  const outputPath = path.join(outDir, `factory-live-verification-${stamp}.json`);
  await writeFile(outputPath, JSON.stringify(summary, null, 2) + "\n", "utf8");

  console.log(`Verification complete: ${artifacts.length} scenarios passed`);
  console.log(`Artifact: ${outputPath}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[verification-failed] ${message}`);
  process.exit(1);
});
