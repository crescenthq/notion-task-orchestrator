import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

const homes: string[] = [];
const originalHome = process.env.HOME;

async function setupRuntime() {
  const home = await mkdtemp(path.join(tmpdir(), "notionflow-runtime-test-"));
  homes.push(home);
  process.env.HOME = home;
  vi.resetModules();

  const [{ nowIso, openApp }, { paths }, runtime, schema] = await Promise.all([
    import("../app/context"),
    import("../config/paths"),
    import("./factoryRuntime"),
    import("../db/schema"),
  ]);

  const { db } = await openApp();
  const timestamp = nowIso();
  return { db, paths, runtime, schema, timestamp };
}

describe("factoryRuntime", () => {
  afterEach(async () => {
    process.env.HOME = originalHome;
    for (const home of homes.splice(0, homes.length)) {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("executes action + orchestrate transitions to terminal done", async () => {
    const { db, paths, runtime, schema, timestamp } = await setupRuntime();
    const factoryId = "runtime-route-factory";
    const externalTaskId = "task-route-1";
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`);

    await writeFile(
      factoryPath,
      `const plan = async ({ ctx }) => ({ status: "done", data: { ...ctx, routeEvent: "matched" } });\n` +
        `const route = ({ ctx }) => ctx.routeEvent;\n` +
        `export default {\n` +
        `  id: "${factoryId}",\n` +
        `  start: "plan",\n` +
        `  context: { routeEvent: "unmatched" },\n` +
        `  states: {\n` +
        `    plan: { type: "action", agent: plan, on: { done: "route", failed: "failed" } },\n` +
        `    route: { type: "orchestrate", select: route, on: { matched: "done", unmatched: "failed" } },\n` +
        `    done: { type: "done" },\n` +
        `    failed: { type: "failed" }\n` +
        `  }\n` +
        `};\n`,
      "utf8",
    );

    await db.insert(schema.boards).values({
      id: factoryId,
      adapter: "local",
      externalId: "local-board",
      configJson: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await db.insert(schema.workflows).values({
      id: factoryId,
      version: 1,
      definitionYaml: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await db.insert(schema.tasks).values({
      id: crypto.randomUUID(),
      boardId: factoryId,
      externalTaskId,
      workflowId: factoryId,
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

    await runtime.runFactoryTaskByExternalId(externalTaskId);

    const [updatedTask] = await db.select().from(schema.tasks).where(eq(schema.tasks.externalTaskId, externalTaskId));
    expect(updatedTask?.state).toBe("done");
    expect(updatedTask?.currentStepId).toBeNull();
    expect(updatedTask).toBeTruthy();

    const events = await db.select().from(schema.transitionEvents).where(eq(schema.transitionEvents.taskId, updatedTask!.id));
    expect(events.length).toBe(2);
    expect(events.map((event) => `${event.fromStateId}->${event.toStateId}`)).toEqual([
      "plan->route",
      "route->done",
    ]);
    expect(events[1]?.event).toBe("matched");
  });

  it("persists feedback pause state and resumes from persisted state/context", async () => {
    const { db, paths, runtime, schema, timestamp } = await setupRuntime();
    const factoryId = "runtime-feedback-factory";
    const externalTaskId = "task-feedback-1";
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`);

    await writeFile(
      factoryPath,
      `const askOrFinish = async ({ ctx }) => {\n` +
        `  const visits = Number(ctx.visits ?? 0) + 1;\n` +
        `  if (!ctx.human_feedback) {\n` +
        `    return { status: "feedback", message: "Need your answer", data: { visits } };\n` +
        `  }\n` +
        `  return { status: "done", data: { visits } };\n` +
        `};\n` +
        `export default {\n` +
        `  id: "${factoryId}",\n` +
        `  start: "work",\n` +
        `  context: { visits: 0 },\n` +
        `  states: {\n` +
        `    work: { type: "action", agent: askOrFinish, on: { done: "done", feedback: "await_human", failed: "failed" } },\n` +
        `    await_human: { type: "feedback", resume: "previous" },\n` +
        `    done: { type: "done" },\n` +
        `    failed: { type: "failed" }\n` +
        `  }\n` +
        `};\n`,
      "utf8",
    );

    await db.insert(schema.boards).values({
      id: factoryId,
      adapter: "local",
      externalId: "local-board",
      configJson: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await db.insert(schema.workflows).values({
      id: factoryId,
      version: 1,
      definitionYaml: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await db.insert(schema.tasks).values({
      id: crypto.randomUUID(),
      boardId: factoryId,
      externalTaskId,
      workflowId: factoryId,
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

    await runtime.runFactoryTaskByExternalId(externalTaskId);

    const [paused] = await db.select().from(schema.tasks).where(eq(schema.tasks.externalTaskId, externalTaskId));
    expect(paused?.state).toBe("feedback");
    expect(paused?.currentStepId).toBe("work");
    const pausedCtx = JSON.parse(paused?.stepVarsJson ?? "{}") as Record<string, unknown>;
    expect(pausedCtx.visits).toBe(1);

    const resumedCtx = { ...pausedCtx, human_feedback: "approved" };
    await db
      .update(schema.tasks)
      .set({ state: "queued", stepVarsJson: JSON.stringify(resumedCtx), updatedAt: new Date().toISOString() })
      .where(eq(schema.tasks.externalTaskId, externalTaskId));

    await runtime.runFactoryTaskByExternalId(externalTaskId);

    const [doneTask] = await db.select().from(schema.tasks).where(eq(schema.tasks.externalTaskId, externalTaskId));
    expect(doneTask?.state).toBe("done");
    expect(doneTask).toBeTruthy();
    const doneCtx = JSON.parse(doneTask?.stepVarsJson ?? "{}") as Record<string, unknown>;
    expect(doneCtx.visits).toBe(2);

    const events = await db.select().from(schema.transitionEvents).where(eq(schema.transitionEvents.taskId, doneTask!.id));
    expect(events.map((event) => event.event)).toEqual(["feedback", "done"]);
  });

  it("uses feedback resume override target when configured", async () => {
    const { db, paths, runtime, schema, timestamp } = await setupRuntime();
    const factoryId = "runtime-feedback-resume-override-factory";
    const externalTaskId = "task-feedback-override-1";
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`);

    await writeFile(
      factoryPath,
      `const ask = async ({ ctx }) => {\n` +
        `  if (!ctx.human_feedback) {\n` +
        `    return { status: "feedback", message: "Need approval" };\n` +
        `  }\n` +
        `  return { status: "done" };\n` +
        `};\n` +
        `const summarize = async () => ({ status: "done" });\n` +
        `export default {\n` +
        `  id: "${factoryId}",\n` +
        `  start: "work",\n` +
        `  states: {\n` +
        `    work: { type: "action", agent: ask, on: { done: "done", feedback: "await_human", failed: "failed" } },\n` +
        `    await_human: { type: "feedback", resume: "summary" },\n` +
        `    summary: { type: "action", agent: summarize, on: { done: "done", failed: "failed" } },\n` +
        `    done: { type: "done" },\n` +
        `    failed: { type: "failed" }\n` +
        `  }\n` +
        `};\n`,
      "utf8",
    );

    await db.insert(schema.boards).values({
      id: factoryId,
      adapter: "local",
      externalId: "local-board",
      configJson: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await db.insert(schema.workflows).values({
      id: factoryId,
      version: 1,
      definitionYaml: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await db.insert(schema.tasks).values({
      id: crypto.randomUUID(),
      boardId: factoryId,
      externalTaskId,
      workflowId: factoryId,
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

    await runtime.runFactoryTaskByExternalId(externalTaskId);

    const [paused] = await db.select().from(schema.tasks).where(eq(schema.tasks.externalTaskId, externalTaskId));
    expect(paused?.state).toBe("feedback");
    expect(paused?.currentStepId).toBe("summary");

    const resumedCtx = {
      ...(JSON.parse(paused?.stepVarsJson ?? "{}") as Record<string, unknown>),
      human_feedback: "approved",
    };
    await db
      .update(schema.tasks)
      .set({ state: "queued", stepVarsJson: JSON.stringify(resumedCtx), updatedAt: new Date().toISOString() })
      .where(eq(schema.tasks.externalTaskId, externalTaskId));

    await runtime.runFactoryTaskByExternalId(externalTaskId);

    const events = await db.select().from(schema.transitionEvents).where(eq(schema.transitionEvents.taskId, paused!.id));
    expect(events.map((event) => `${event.fromStateId}->${event.toStateId}`)).toEqual([
      "work->await_human",
      "summary->done",
    ]);
  });

  it("executes bounded loop until done guard is satisfied", async () => {
    const { db, paths, runtime, schema, timestamp } = await setupRuntime();
    const factoryId = "runtime-loop-done-factory";
    const externalTaskId = "task-loop-done-1";
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`);

    await writeFile(
      factoryPath,
      `const iterate = async ({ ctx }) => ({ status: "done", data: { iterations: Number(ctx.iterations ?? 0) + 1 } });\n` +
        `const loopDone = ({ ctx }) => Number(ctx.iterations ?? 0) >= 2;\n` +
        `export default {\n` +
        `  id: "${factoryId}",\n` +
        `  start: "loop_gate",\n` +
        `  context: { iterations: 0 },\n` +
        `  guards: { loopDone },\n` +
        `  states: {\n` +
        `    loop_gate: { type: "loop", body: "work", maxIterations: 5, until: "loopDone", on: { continue: "work", done: "done", exhausted: "failed" } },\n` +
        `    work: { type: "action", agent: iterate, on: { done: "loop_gate", failed: "failed" } },\n` +
        `    done: { type: "done" },\n` +
        `    failed: { type: "failed" }\n` +
        `  }\n` +
        `};\n`,
      "utf8",
    );

    await db.insert(schema.boards).values({
      id: factoryId,
      adapter: "local",
      externalId: "local-board",
      configJson: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await db.insert(schema.workflows).values({
      id: factoryId,
      version: 1,
      definitionYaml: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await db.insert(schema.tasks).values({
      id: crypto.randomUUID(),
      boardId: factoryId,
      externalTaskId,
      workflowId: factoryId,
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

    await runtime.runFactoryTaskByExternalId(externalTaskId);

    const [updatedTask] = await db.select().from(schema.tasks).where(eq(schema.tasks.externalTaskId, externalTaskId));
    expect(updatedTask?.state).toBe("done");
    const doneCtx = JSON.parse(updatedTask?.stepVarsJson ?? "{}") as Record<string, unknown>;
    expect(doneCtx.iterations).toBe(2);

    const events = await db.select().from(schema.transitionEvents).where(eq(schema.transitionEvents.taskId, updatedTask!.id));
    expect(events.map((event) => `${event.fromStateId}->${event.toStateId}:${event.event}`)).toEqual([
      "loop_gate->work:continue",
      "work->loop_gate:done",
      "loop_gate->work:continue",
      "work->loop_gate:done",
      "loop_gate->done:done",
    ]);

    const loopEvents = events.filter((event) => event.fromStateId === "loop_gate");
    expect(loopEvents.map((event) => event.loopIteration)).toEqual([1, 2, 2]);
  });

  it("exits bounded loop with exhausted route when max iterations reached", async () => {
    const { db, paths, runtime, schema, timestamp } = await setupRuntime();
    const factoryId = "runtime-loop-exhausted-factory";
    const externalTaskId = "task-loop-exhausted-1";
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`);

    await writeFile(
      factoryPath,
      `const iterate = async ({ ctx }) => ({ status: "done", data: { iterations: Number(ctx.iterations ?? 0) + 1 } });\n` +
        `const neverDone = () => false;\n` +
        `export default {\n` +
        `  id: "${factoryId}",\n` +
        `  start: "loop_gate",\n` +
        `  context: { iterations: 0 },\n` +
        `  guards: { neverDone },\n` +
        `  states: {\n` +
        `    loop_gate: { type: "loop", body: "work", maxIterations: 2, until: "neverDone", on: { continue: "work", done: "done", exhausted: "failed" } },\n` +
        `    work: { type: "action", agent: iterate, on: { done: "loop_gate", failed: "failed" } },\n` +
        `    done: { type: "done" },\n` +
        `    failed: { type: "failed" }\n` +
        `  }\n` +
        `};\n`,
      "utf8",
    );

    await db.insert(schema.boards).values({
      id: factoryId,
      adapter: "local",
      externalId: "local-board",
      configJson: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await db.insert(schema.workflows).values({
      id: factoryId,
      version: 1,
      definitionYaml: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await db.insert(schema.tasks).values({
      id: crypto.randomUUID(),
      boardId: factoryId,
      externalTaskId,
      workflowId: factoryId,
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

    await runtime.runFactoryTaskByExternalId(externalTaskId);

    const [updatedTask] = await db.select().from(schema.tasks).where(eq(schema.tasks.externalTaskId, externalTaskId));
    expect(updatedTask?.state).toBe("failed");
    const doneCtx = JSON.parse(updatedTask?.stepVarsJson ?? "{}") as Record<string, unknown>;
    expect(doneCtx.iterations).toBe(2);

    const events = await db.select().from(schema.transitionEvents).where(eq(schema.transitionEvents.taskId, updatedTask!.id));
    expect(events.map((event) => `${event.fromStateId}->${event.toStateId}:${event.event}`)).toEqual([
      "loop_gate->work:continue",
      "work->loop_gate:done",
      "loop_gate->work:continue",
      "work->loop_gate:done",
      "loop_gate->failed:exhausted",
    ]);

    const exhausted = events.find((event) => event.event === "exhausted");
    expect(exhausted?.loopIteration).toBe(2);
    expect(exhausted?.reason).toBe("loop.exhausted");
  });

  it("retries failed action states and succeeds before exhaustion", async () => {
    const { db, paths, runtime, schema, timestamp } = await setupRuntime();
    const factoryId = "runtime-retry-success-factory";
    const externalTaskId = "task-retry-success-1";
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`);

    await writeFile(
      factoryPath,
      `const flaky = async ({ ctx }) => {\n` +
        `  const attempts = Number(ctx.attempts ?? 0) + 1;\n` +
        `  if (attempts < 3) {\n` +
        `    return { status: "failed", message: "transient", data: { attempts } };\n` +
        `  }\n` +
        `  return { status: "done", data: { attempts } };\n` +
        `};\n` +
        `export default {\n` +
        `  id: "${factoryId}",\n` +
        `  start: "work",\n` +
        `  context: { attempts: 0 },\n` +
        `  states: {\n` +
        `    work: { type: "action", agent: flaky, retries: { max: 2, backoff: { ms: 0 } }, on: { done: "done", failed: "failed" } },\n` +
        `    done: { type: "done" },\n` +
        `    failed: { type: "failed" }\n` +
        `  }\n` +
        `};\n`,
      "utf8",
    );

    await db.insert(schema.boards).values({
      id: factoryId,
      adapter: "local",
      externalId: "local-board",
      configJson: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await db.insert(schema.workflows).values({
      id: factoryId,
      version: 1,
      definitionYaml: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await db.insert(schema.tasks).values({
      id: crypto.randomUUID(),
      boardId: factoryId,
      externalTaskId,
      workflowId: factoryId,
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

    await runtime.runFactoryTaskByExternalId(externalTaskId);

    const [updatedTask] = await db.select().from(schema.tasks).where(eq(schema.tasks.externalTaskId, externalTaskId));
    expect(updatedTask?.state).toBe("done");
    const doneCtx = JSON.parse(updatedTask?.stepVarsJson ?? "{}") as Record<string, unknown>;
    expect(doneCtx.attempts).toBe(3);

    const events = await db.select().from(schema.transitionEvents).where(eq(schema.transitionEvents.taskId, updatedTask!.id));
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("done");
    expect(events[0]?.attempt).toBe(3);
  });

  it("routes to configured failed target when retries are exhausted", async () => {
    const { db, paths, runtime, schema, timestamp } = await setupRuntime();
    const factoryId = "runtime-retry-fail-factory";
    const externalTaskId = "task-retry-fail-1";
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`);

    await writeFile(
      factoryPath,
      `const alwaysFail = async ({ ctx }) => ({ status: "failed", message: "hard-fail", data: { attempts: Number(ctx.attempts ?? 0) + 1 } });\n` +
        `export default {\n` +
        `  id: "${factoryId}",\n` +
        `  start: "work",\n` +
        `  context: { attempts: 0 },\n` +
        `  states: {\n` +
        `    work: { type: "action", agent: alwaysFail, retries: { max: 1 }, on: { done: "done", failed: "failed" } },\n` +
        `    done: { type: "done" },\n` +
        `    failed: { type: "failed" }\n` +
        `  }\n` +
        `};\n`,
      "utf8",
    );

    await db.insert(schema.boards).values({
      id: factoryId,
      adapter: "local",
      externalId: "local-board",
      configJson: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await db.insert(schema.workflows).values({
      id: factoryId,
      version: 1,
      definitionYaml: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await db.insert(schema.tasks).values({
      id: crypto.randomUUID(),
      boardId: factoryId,
      externalTaskId,
      workflowId: factoryId,
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

    await runtime.runFactoryTaskByExternalId(externalTaskId);

    const [updatedTask] = await db.select().from(schema.tasks).where(eq(schema.tasks.externalTaskId, externalTaskId));
    expect(updatedTask?.state).toBe("failed");
    expect(updatedTask?.lastError).toContain("hard-fail");

    const events = await db.select().from(schema.transitionEvents).where(eq(schema.transitionEvents.taskId, updatedTask!.id));
    expect(events.map((event) => event.event)).toEqual(["failed"]);
    expect(events[0]?.reason).toBe("action.failed.exhausted");
    expect(events[0]?.attempt).toBe(2);
  });

  it("fails when action agent returns an invalid status", async () => {
    const { db, paths, runtime, schema, timestamp } = await setupRuntime();
    const factoryId = "runtime-invalid-action-status-factory";
    const externalTaskId = "task-invalid-action-status-1";
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`);

    await writeFile(
      factoryPath,
      `const badStatus = async () => ({ status: "route" });\n` +
        `export default {\n` +
        `  id: "${factoryId}",\n` +
        `  start: "work",\n` +
        `  states: {\n` +
        `    work: { type: "action", agent: badStatus, on: { done: "done", failed: "failed" } },\n` +
        `    done: { type: "done" },\n` +
        `    failed: { type: "failed" }\n` +
        `  }\n` +
        `};\n`,
      "utf8",
    );

    await db.insert(schema.boards).values({
      id: factoryId,
      adapter: "local",
      externalId: "local-board",
      configJson: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await db.insert(schema.workflows).values({
      id: factoryId,
      version: 1,
      definitionYaml: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await db.insert(schema.tasks).values({
      id: crypto.randomUUID(),
      boardId: factoryId,
      externalTaskId,
      workflowId: factoryId,
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

    await runtime.runFactoryTaskByExternalId(externalTaskId);

    const [updatedTask] = await db.select().from(schema.tasks).where(eq(schema.tasks.externalTaskId, externalTaskId));
    expect(updatedTask?.state).toBe("failed");
    expect(updatedTask?.lastError).toContain("must be one of done, feedback, failed");
  });

  it("fails when action agent returns non-object data payload", async () => {
    const { db, paths, runtime, schema, timestamp } = await setupRuntime();
    const factoryId = "runtime-invalid-action-data-factory";
    const externalTaskId = "task-invalid-action-data-1";
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`);

    await writeFile(
      factoryPath,
      `const badData = async () => ({ status: "done", data: "not-an-object" });\n` +
        `export default {\n` +
        `  id: "${factoryId}",\n` +
        `  start: "work",\n` +
        `  states: {\n` +
        `    work: { type: "action", agent: badData, on: { done: "done", failed: "failed" } },\n` +
        `    done: { type: "done" },\n` +
        `    failed: { type: "failed" }\n` +
        `  }\n` +
        `};\n`,
      "utf8",
    );

    await db.insert(schema.boards).values({
      id: factoryId,
      adapter: "local",
      externalId: "local-board",
      configJson: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await db.insert(schema.workflows).values({
      id: factoryId,
      version: 1,
      definitionYaml: "{}",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await db.insert(schema.tasks).values({
      id: crypto.randomUUID(),
      boardId: factoryId,
      externalTaskId,
      workflowId: factoryId,
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

    await runtime.runFactoryTaskByExternalId(externalTaskId);

    const [updatedTask] = await db.select().from(schema.tasks).where(eq(schema.tasks.externalTaskId, externalTaskId));
    expect(updatedTask?.state).toBe("failed");
    expect(updatedTask?.lastError).toContain("field `data` must be an object");
  });
});
