import { defineCommand } from "citty";
import { and, eq } from "drizzle-orm";
import YAML from "yaml";
import { nowIso, openApp } from "../app/context";
import { notionToken } from "../config/env";
import { parseKeyValues, parseStatusDirective, renderTemplate, workflowSchema } from "../core/workflow";
import { boards, executors, tasks, workflows } from "../db/schema";
import { notionAppendTaskPageLog, notionGetPage, notionGetPageBodyText, notionUpdateTaskPageState, pageTitle } from "../services/notion";

function isExecutorAuthError(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return normalized.includes("not logged in") || normalized.includes("please run /login");
}

function isOperationalLogLine(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  return (
    normalized.startsWith("run started") ||
    normalized.startsWith("step started:") ||
    normalized.startsWith("step ") ||
    normalized.startsWith("task complete") ||
    normalized.startsWith("task failed") ||
    normalized.startsWith("task blocked") ||
    normalized.startsWith("executor:") ||
    normalized.startsWith("workflow:") ||
    normalized.startsWith("status:")
  );
}

async function executeStepWithExecutor(
  commandPath: string,
  payload: { prompt: string; session_id: string; timeout: number; workdir: string; step_id: string; task_id: string },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([commandPath], {
    env: { ...process.env, AGENT_ACTION: "execute" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();

  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

export async function runTaskByExternalId(taskExternalId: string): Promise<void> {
  const { db } = await openApp();
  const [task] = await db.select().from(tasks).where(eq(tasks.externalTaskId, taskExternalId));
  if (!task) throw new Error(`Task not found: ${taskExternalId}`);

  const [board] = await db.select().from(boards).where(eq(boards.id, task.boardId));
  const token = notionToken();
  const syncNotionState = async (state: string): Promise<void> => {
    if (!board || board.adapter !== "notion") return;
    if (!token) {
      console.log("[warn] skipping Notion task state update (NOTION_API_TOKEN missing)");
      return;
    }
    await notionUpdateTaskPageState(token, task.externalTaskId, state);
  };
  const syncNotionLog = async (title: string, detail?: string): Promise<void> => {
    if (!board || board.adapter !== "notion") return;
    if (!token) return;
    try {
      await notionAppendTaskPageLog(token, task.externalTaskId, title, detail);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[warn] failed to append Notion page log: ${message}`);
    }
  };

  const [workflowRow] = await db.select().from(workflows).where(eq(workflows.id, task.workflowId));
  if (!workflowRow) throw new Error(`Workflow not found: ${task.workflowId}`);

  let taskTitle = task.externalTaskId;
  let taskContext = "";
  if (board?.adapter === "notion" && token) {
    try {
      const notionPage = await notionGetPage(token, task.externalTaskId);
      taskTitle = pageTitle(notionPage);
      taskContext = await notionGetPageBodyText(token, task.externalTaskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[warn] failed to load Notion page content for prompt vars: ${message}`);
    }
  }

  const promptCandidates = taskContext
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isOperationalLogLine(line));
  const taskPrompt = promptCandidates[0] ?? taskTitle;

  const workflow = workflowSchema.parse(YAML.parse(workflowRow.definitionYaml));
  const stepVars: Record<string, string> = {
    task_id: task.externalTaskId,
    task_title: taskTitle,
    task_name: taskPrompt,
    task_prompt: taskPrompt,
    task_context: taskContext,
  };

  await db
    .update(tasks)
    .set({ state: "running", updatedAt: nowIso(), lastError: null })
    .where(and(eq(tasks.boardId, task.boardId), eq(tasks.externalTaskId, task.externalTaskId)));
  await syncNotionState("running");
  await syncNotionLog("Run started", `Workflow: ${task.workflowId}`);

  for (const step of workflow.steps) {
    await db
      .update(tasks)
      .set({ state: "running", currentStepId: step.id, updatedAt: nowIso(), lastError: null })
      .where(and(eq(tasks.boardId, task.boardId), eq(tasks.externalTaskId, task.externalTaskId)));
    // Surface per-step progress directly in Notion Status while running.
    await syncNotionState(step.id);
    await syncNotionLog(`Step started: ${step.id}`, `Executor: ${step.agent}`);

    const [executor] = await db.select().from(executors).where(eq(executors.id, step.agent));
    if (!executor) throw new Error(`Executor not found for step ${step.id}: ${step.agent}`);

    const prompt = renderTemplate(step.prompt, stepVars);
    const timeout = step.timeout ?? executor.defaultTimeoutSeconds ?? 600;

    const payload = {
      prompt,
      session_id: `task-${task.externalTaskId}`,
      timeout,
      workdir: process.cwd(),
      step_id: step.id,
      task_id: task.externalTaskId,
    };

    let executorUsed = executor.id;
    let { exitCode, stdout, stderr } = await executeStepWithExecutor(executor.commandPath, payload);

    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim() || "no output";
      if (executor.id === "claude" && isExecutorAuthError(detail)) {
        const [fallback] = await db.select().from(executors).where(eq(executors.id, "codex"));
        if (fallback) {
          console.log(`[warn] claude executor unavailable; retrying step ${step.id} with codex`);
          executorUsed = fallback.id;
          ({ exitCode, stdout, stderr } = await executeStepWithExecutor(fallback.commandPath, payload));
        }
      }
    }

    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim() || "no output";
      const message = `Step ${step.id} failed (${exitCode}): ${detail}`;
      await db
        .update(tasks)
        .set({ state: "failed", currentStepId: step.id, updatedAt: nowIso(), lastError: message })
        .where(and(eq(tasks.boardId, task.boardId), eq(tasks.externalTaskId, task.externalTaskId)));
      await syncNotionState("failed");
      await syncNotionLog(`Step failed: ${step.id}`, detail);
      throw new Error(message);
    }

    const parsedStatus = parseStatusDirective(stdout);
    if (!parsedStatus) {
      const detail = `Missing STATUS directive in step output. Raw output:\n${(stdout.trim() || "<empty>").slice(0, 2000)}`;
      const message = `Step ${step.id} failed: ${detail}`;
      await db
        .update(tasks)
        .set({ state: "failed", currentStepId: step.id, updatedAt: nowIso(), lastError: message })
        .where(and(eq(tasks.boardId, task.boardId), eq(tasks.externalTaskId, task.externalTaskId)));
      await syncNotionState("failed");
      await syncNotionLog(`Step failed: ${step.id}`, detail);
      throw new Error(message);
    }

    const status = parsedStatus;
    const kv = parseKeyValues(stdout);
    for (const [k, v] of Object.entries(kv)) stepVars[`${step.id}_${k}`] = v;
    stepVars[`step_${step.id}_output`] = stdout;

    console.log(`step ${step.id} via ${executorUsed}: ${status}`);
    await syncNotionLog(`Step ${step.id}: ${status}`, stdout.trim() || "no output");
    if (status === "blocked" || status === "failed") {
      const detail = stderr.trim() || stdout.trim() || null;
      await db
        .update(tasks)
        .set({ state: status, currentStepId: step.id, updatedAt: nowIso(), lastError: detail })
        .where(and(eq(tasks.boardId, task.boardId), eq(tasks.externalTaskId, task.externalTaskId)));
      await syncNotionState(status);
      await syncNotionLog(`Task ${status}`, detail ?? "no detail");
      return;
    }
  }

  await db
    .update(tasks)
    .set({ state: "done", currentStepId: null, updatedAt: nowIso(), lastError: null })
    .where(and(eq(tasks.boardId, task.boardId), eq(tasks.externalTaskId, task.externalTaskId)));
  await syncNotionState("done");
  await syncNotionLog("Task complete", "All workflow steps finished successfully.");

  console.log("Task run complete: done");
}

export const runCmd = defineCommand({
  meta: { name: "run", description: "Run a workflow for one task using per-step executors" },
  args: {
    task: { type: "string", required: true },
  },
  async run({ args }) {
    await runTaskByExternalId(String(args.task));
  },
});
