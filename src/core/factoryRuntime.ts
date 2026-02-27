import { access } from "node:fs/promises";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { nowIso, openApp } from "../app/context";
import { notionToken } from "../config/env";
import { paths } from "../config/paths";
import { loadFactoryFromPath } from "./factory";
import { boards, runs, tasks, transitionEvents, workflows } from "../db/schema";
import {
  notionAppendTaskPageLog,
  notionGetPage,
  notionGetPageBodyText,
  notionPostComment,
  notionUpdateTaskPageState,
  pageTitle,
} from "../services/notion";

type JsonObject = Record<string, unknown>;

type AgentResult = {
  status: string;
  data?: JsonObject;
  message?: string;
};

type RetryBackoff = {
  strategy?: "fixed" | "exponential";
  ms: number;
  maxMs?: number;
};

const MAX_TRANSITIONS_PER_RUN = 200;
const RETRY_ATTEMPTS_KEY = "__nf_retry_attempts";

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeAgentResult(value: unknown, stateId: string): AgentResult {
  if (!isRecord(value)) {
    throw new Error(`State \`${stateId}\` agent returned a non-object result`);
  }

  const status = value.status;
  if (typeof status !== "string" || status.length === 0) {
    throw new Error(`State \`${stateId}\` agent result missing string \`status\``);
  }

  const data = isRecord(value.data) ? value.data : undefined;
  const message = typeof value.message === "string" ? value.message : undefined;
  return { status, data, message };
}

function mergeContext(base: JsonObject, patch?: JsonObject): JsonObject {
  return patch ? { ...base, ...patch } : base;
}

function getRetryAttempts(ctx: JsonObject): Record<string, number> {
  const raw = ctx[RETRY_ATTEMPTS_KEY];
  if (!isRecord(raw)) return {};
  const parsed: Record<string, number> = {};
  for (const [stateId, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      parsed[stateId] = Math.floor(value);
    }
  }
  return parsed;
}

function setRetryAttempt(ctx: JsonObject, stateId: string, attempt: number): JsonObject {
  const attempts = getRetryAttempts(ctx);
  attempts[stateId] = Math.max(0, Math.floor(attempt));
  return mergeContext(ctx, { [RETRY_ATTEMPTS_KEY]: attempts });
}

function clearRetryAttempt(ctx: JsonObject, stateId: string): JsonObject {
  const attempts = getRetryAttempts(ctx);
  if (!(stateId in attempts)) return ctx;
  delete attempts[stateId];
  return mergeContext(ctx, { [RETRY_ATTEMPTS_KEY]: attempts });
}

function backoffDelayMs(backoff: RetryBackoff | undefined, attempt: number): number {
  if (!backoff) return 0;
  const baseMs = Math.max(0, Math.floor(backoff.ms));
  if (baseMs === 0) return 0;
  const strategy = backoff.strategy ?? "fixed";
  const computed =
    strategy === "exponential"
      ? baseMs * Math.max(1, 2 ** Math.max(0, attempt - 1))
      : baseMs;
  const capped = typeof backoff.maxMs === "number" ? Math.min(computed, Math.max(0, Math.floor(backoff.maxMs))) : computed;
  return Math.max(0, Math.floor(capped));
}

async function waitFor(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveInstalledFactoryPath(factoryId: string): Promise<string> {
  const candidates = [".ts", ".mts", ".js", ".mjs", ".cts", ".cjs"].map((ext) =>
    path.join(paths.workflowsDir, `${factoryId}${ext}`),
  );
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // keep searching
    }
  }
  throw new Error(
    `Factory module not found for \`${factoryId}\`. Expected one of: ${candidates.join(", ")}`,
  );
}

function getTaskSelector(task: { boardId: string; externalTaskId: string }) {
  return and(eq(tasks.boardId, task.boardId), eq(tasks.externalTaskId, task.externalTaskId));
}

export async function runFactoryTaskByExternalId(taskExternalId: string): Promise<void> {
  const { db } = await openApp();
  const [task] = await db.select().from(tasks).where(eq(tasks.externalTaskId, taskExternalId));
  if (!task) throw new Error(`Task not found: ${taskExternalId}`);

  const [workflowRow] = await db.select().from(workflows).where(eq(workflows.id, task.workflowId));
  if (!workflowRow) throw new Error(`Factory not found: ${task.workflowId}`);

  const [board] = await db.select().from(boards).where(eq(boards.id, task.boardId));
  const token = notionToken();

  const syncNotionState = async (state: string, stateLabel?: string): Promise<void> => {
    if (!board || board.adapter !== "notion") return;
    if (!token) {
      console.log("[warn] skipping Notion task state update (NOTION_API_TOKEN missing)");
      return;
    }
    await notionUpdateTaskPageState(token, task.externalTaskId, state, stateLabel);
  };

  const syncNotionLog = async (title: string, detail?: string): Promise<void> => {
    if (!board || board.adapter !== "notion" || !token) return;
    try {
      await notionAppendTaskPageLog(token, task.externalTaskId, title, detail);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[warn] failed to append Notion page log: ${message}`);
    }
  };

  const factoryPath = await resolveInstalledFactoryPath(task.workflowId);
  const { definition } = await loadFactoryFromPath(factoryPath);

  let taskTitle = task.externalTaskId;
  let taskContext = "";
  if (board?.adapter === "notion" && token) {
    try {
      const notionPage = await notionGetPage(token, task.externalTaskId);
      taskTitle = pageTitle(notionPage);
      taskContext = await notionGetPageBodyText(token, task.externalTaskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[warn] failed to load Notion page content for context: ${message}`);
    }
  }

  const promptLine = taskContext
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const taskPrompt = promptLine ?? taskTitle;

  let ctx: JsonObject = {
    ...(isRecord(definition.context) ? definition.context : {}),
    task_id: task.externalTaskId,
    task_title: taskTitle,
    task_prompt: taskPrompt,
    task_context: taskContext,
  };

  if (task.stepVarsJson) {
    try {
      const persisted = JSON.parse(task.stepVarsJson);
      if (isRecord(persisted)) ctx = mergeContext(ctx, persisted);
    } catch {
      console.log("[warn] failed to parse persisted factory context; using defaults");
    }
  }

  let currentStateId = task.currentStepId ?? definition.start;
  const resumed = task.currentStepId !== null || task.stepVarsJson !== null;

  const [activeRun] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.taskId, task.id), isNull(runs.endedAt), eq(runs.status, "running")));
  const runId = activeRun?.id ?? crypto.randomUUID();
  const now = nowIso();
  if (!activeRun) {
    await db.insert(runs).values({
      id: runId,
      taskId: task.id,
      status: "running",
      startedAt: now,
      endedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    await db.update(runs).set({ status: "running", updatedAt: now }).where(eq(runs.id, runId));
  }

  const tickId = crypto.randomUUID();

  const finalizeRun = async (status: "done" | "blocked" | "failed"): Promise<void> => {
    const timestamp = nowIso();
    const isDone = status === "done";
    await db
      .update(tasks)
      .set({
        state: status,
        currentStepId: null,
        stepVarsJson: JSON.stringify(ctx),
        waitingSince: null,
        updatedAt: timestamp,
        lastError: isDone ? null : String(ctx.last_error ?? `Terminal state: ${status}`),
      })
      .where(getTaskSelector(task));
    await db
      .update(runs)
      .set({
        status,
        endedAt: timestamp,
        updatedAt: timestamp,
      })
      .where(eq(runs.id, runId));
    await syncNotionState(status);
    await syncNotionLog(
      status === "done" ? "Task complete" : `Task ${status}`,
      status === "done" ? "Factory reached terminal done state." : String(ctx.last_error ?? "no detail"),
    );
  };

  const failRun = async (message: string): Promise<never> => {
    const timestamp = nowIso();
    ctx = mergeContext(ctx, { last_error: message });
    await db
      .update(tasks)
      .set({
        state: "failed",
        currentStepId: currentStateId,
        stepVarsJson: JSON.stringify(ctx),
        updatedAt: timestamp,
        lastError: message,
      })
      .where(getTaskSelector(task));
    await db
      .update(runs)
      .set({ status: "failed", endedAt: timestamp, updatedAt: timestamp })
      .where(eq(runs.id, runId));
    await syncNotionState("failed");
    await syncNotionLog("Task failed", message);
    throw new Error(message);
  };

  const persistTransition = async (
    fromStateId: string,
    toStateId: string,
    event: string,
    reason: string,
    attempt: number,
  ): Promise<void> => {
    await db.insert(transitionEvents).values({
      id: crypto.randomUUID(),
      runId,
      tickId,
      taskId: task.id,
      fromStateId,
      toStateId,
      event,
      reason,
      attempt,
      loopIteration: 0,
      timestamp: nowIso(),
    });
  };

  await db
    .update(tasks)
    .set({ state: "running", updatedAt: nowIso(), lastError: null, waitingSince: null })
    .where(getTaskSelector(task));
  await syncNotionState("running");
  await syncNotionLog(resumed ? `Resuming from state ${currentStateId}` : "Run started", `Factory: ${definition.id}`);

  let transitions = 0;
  while (transitions < MAX_TRANSITIONS_PER_RUN) {
    const state = definition.states[currentStateId];
    if (!state) await failRun(`State not found in factory graph: ${currentStateId}`);

    if (state.type === "done" || state.type === "failed" || state.type === "blocked") {
      await finalizeRun(state.type);
      console.log(`Task run complete: ${state.type}`);
      return;
    }

    if (state.type === "feedback") {
      await db
        .update(tasks)
        .set({
          state: "feedback",
          currentStepId: currentStateId,
          stepVarsJson: JSON.stringify(ctx),
          waitingSince: nowIso(),
          updatedAt: nowIso(),
          lastError: null,
        })
        .where(getTaskSelector(task));
      await db.update(runs).set({ status: "feedback", updatedAt: nowIso() }).where(eq(runs.id, runId));
      await syncNotionState("feedback");
      await syncNotionLog(`Feedback needed: ${currentStateId}`, "Awaiting human input.");
      return;
    }

    await db
      .update(tasks)
      .set({
        state: "running",
        currentStepId: currentStateId,
        stepVarsJson: JSON.stringify(ctx),
        updatedAt: nowIso(),
        lastError: null,
      })
      .where(getTaskSelector(task));
    await syncNotionState("running", currentStateId);

    let event = "";
    let nextStateId: string | undefined;
    let reason = "";
    let feedbackMessage: string | undefined;
    let transitionAttempt = 0;

    if (state.type === "action") {
      const maxRetries = Math.max(0, state.retries?.max ?? 0);
      let attempt = Math.max(0, getRetryAttempts(ctx)[currentStateId] ?? 0) + 1;

      // Retry loop is internal to a single action state and exits by emitting one routed event.
      while (true) {
        try {
          const result = normalizeAgentResult(
            await (state.agent as (input: unknown) => unknown)({
              task: {
                id: task.externalTaskId,
                title: taskTitle,
                prompt: taskPrompt,
                context: taskContext,
              },
              ctx,
              stateId: currentStateId,
              runId,
              tickId,
              attempt,
            }),
            currentStateId,
          );

          ctx = mergeContext(ctx, result.data);
          feedbackMessage = result.message;

          if (result.status !== "failed") {
            ctx = clearRetryAttempt(ctx, currentStateId);
            event = result.status;
            reason = `action.${event}`;
            nextStateId = state.on[event];
            transitionAttempt = attempt;
            break;
          }

          const failureMessage =
            result.message ??
            `State \`${currentStateId}\` returned \`failed\` on attempt ${attempt}`;
          ctx = mergeContext(setRetryAttempt(ctx, currentStateId, attempt), { last_error: failureMessage });

          const canRetry = attempt <= maxRetries;
          if (!canRetry) {
            event = "failed";
            reason = "action.failed.exhausted";
            nextStateId = state.on.failed;
            transitionAttempt = attempt;
            break;
          }

          await syncNotionLog(
            `Retrying state: ${currentStateId}`,
            `Attempt ${attempt}/${maxRetries + 1} failed: ${failureMessage}`,
          );
          await db
            .update(tasks)
            .set({
              state: "running",
              currentStepId: currentStateId,
              stepVarsJson: JSON.stringify(ctx),
              updatedAt: nowIso(),
              lastError: failureMessage,
            })
            .where(getTaskSelector(task));

          const delayMs = backoffDelayMs(state.retries?.backoff as RetryBackoff | undefined, attempt);
          await waitFor(delayMs);
          attempt += 1;
        } catch (error) {
          const failureMessage = error instanceof Error ? error.message : String(error);
          ctx = mergeContext(setRetryAttempt(ctx, currentStateId, attempt), { last_error: failureMessage });
          const canRetry = attempt <= maxRetries;

          if (!canRetry) {
            event = "failed";
            reason = "action.failed.exhausted";
            nextStateId = state.on.failed;
            transitionAttempt = attempt;
            break;
          }

          await syncNotionLog(
            `Retrying state: ${currentStateId}`,
            `Attempt ${attempt}/${maxRetries + 1} failed with error: ${failureMessage}`,
          );
          await db
            .update(tasks)
            .set({
              state: "running",
              currentStepId: currentStateId,
              stepVarsJson: JSON.stringify(ctx),
              updatedAt: nowIso(),
              lastError: failureMessage,
            })
            .where(getTaskSelector(task));

          const delayMs = backoffDelayMs(state.retries?.backoff as RetryBackoff | undefined, attempt);
          await waitFor(delayMs);
          attempt += 1;
        }
      }
    } else if (state.type === "orchestrate") {
      if (state.agent) {
        const result = normalizeAgentResult(
          await (state.agent as (input: unknown) => unknown)({
            task: {
              id: task.externalTaskId,
              title: taskTitle,
              prompt: taskPrompt,
              context: taskContext,
            },
            ctx,
            stateId: currentStateId,
            runId,
            tickId,
          }),
          currentStateId,
        );
        ctx = mergeContext(ctx, result.data);
        const routedEvent = result.data?.event;
        event = typeof routedEvent === "string" && routedEvent.length > 0 ? routedEvent : result.status;
        reason = "orchestrate.agent";
        feedbackMessage = result.message;
        transitionAttempt = 1;
      } else if (state.select) {
        const selected = await (state.select as (input: unknown) => unknown)({
          task: {
            id: task.externalTaskId,
            title: taskTitle,
            prompt: taskPrompt,
            context: taskContext,
          },
          ctx,
          stateId: currentStateId,
          runId,
          tickId,
        });
        event = String(selected);
        reason = "orchestrate.select";
        transitionAttempt = 1;
      } else {
        await failRun(`Orchestrate state \`${currentStateId}\` must define agent or select`);
      }
      nextStateId = state.on[event];
    } else {
      await failRun(`State type \`${state.type}\` is not supported by runtime yet`);
    }

    if (!event || !reason) {
      await failRun(`State \`${currentStateId}\` did not emit a valid transition event`);
    }
    if (!nextStateId) {
      await failRun(`State \`${currentStateId}\` emitted event \`${event}\` with no matching transition`);
    }
    const resolvedNextStateId: string =
      nextStateId ?? (await failRun(`State \`${currentStateId}\` missing next transition target`));
    if (!definition.states[resolvedNextStateId]) {
      await failRun(`State \`${currentStateId}\` transition target \`${resolvedNextStateId}\` does not exist`);
    }

    await persistTransition(currentStateId, resolvedNextStateId, event, reason, Math.max(0, transitionAttempt));
    transitions += 1;

    if (definition.states[resolvedNextStateId]?.type === "feedback") {
      if (feedbackMessage && token && board?.adapter === "notion") {
        try {
          await notionPostComment(token, task.externalTaskId, feedbackMessage);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`[warn] failed to post Notion comment: ${message}`);
        }
      }

      await db
        .update(tasks)
        .set({
          state: "feedback",
          currentStepId: currentStateId,
          stepVarsJson: JSON.stringify(ctx),
          waitingSince: nowIso(),
          updatedAt: nowIso(),
          lastError: null,
        })
        .where(getTaskSelector(task));
      await db.update(runs).set({ status: "feedback", updatedAt: nowIso() }).where(eq(runs.id, runId));
      await syncNotionState("feedback");
      await syncNotionLog(
        `Feedback needed: ${currentStateId}`,
        feedbackMessage ?? "Reply to the Notion task comments to continue.",
      );
      return;
    }

    currentStateId = resolvedNextStateId;
  }

  await failRun(`Transition budget exceeded (${MAX_TRANSITIONS_PER_RUN})`);
}
