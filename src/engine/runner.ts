import { NotionClient } from "../notion/client.js";
import type { WorkflowDefinition, WorkflowStep } from "../workflows/dsl.js";
import { describeAgent, executeAgent } from "./agents.js";
import {
  type WorkflowRunState,
  createInitialState,
  loadRunState,
  saveRunState,
} from "./context.js";
import { parseKeyValueOutput, parseStatusDirective } from "./output-parser.js";
import { hasTemplateVars, resolveTemplate } from "./template.js";

const DEFAULT_TASK_WORKDIR =
  process.env.ORCHESTRATOR_TASK_WORKDIR ??
  "/home/exedev/.openclaw/workspace/playground/notion-task-orchestrator";

export type WorkflowInput = {
  pageId: string;
  taskName: string;
  sessionKey: string;
  taskContext: string;
  workdir?: string;
};

export async function runWorkflow(
  client: NotionClient,
  workflow: WorkflowDefinition,
  input: WorkflowInput,
): Promise<WorkflowRunState> {
  const state = createInitialState(workflow.id);
  seedVariables(state, input, workflow);
  return executeFromStep(client, workflow, input, state);
}

export async function resumeWorkflow(
  client: NotionClient,
  workflow: WorkflowDefinition,
  input: WorkflowInput,
): Promise<WorkflowRunState> {
  const saved = await loadRunState(input.pageId);
  if (!saved || saved.workflowId !== workflow.id) {
    return runWorkflow(client, workflow, input);
  }

  if (saved.status !== "blocked") {
    return saved;
  }

  saved.status = "running";
  saved.currentStepIndex += 1;
  saved.blockedAtStepId = undefined;
  saved.blockedReason = undefined;

  seedVariables(saved, input, workflow);
  return executeFromStep(client, workflow, input, saved);
}

function seedVariables(
  state: WorkflowRunState,
  input: WorkflowInput,
  workflow: WorkflowDefinition,
) {
  state.variables.task_name = input.taskName;
  state.variables.task_context =
    input.taskContext || "(No task body content found. Ask for clarification if needed.)";
  state.variables.workdir = input.workdir ?? (workflow as any).workdir ?? DEFAULT_TASK_WORKDIR;
}

function resolveStepPrompt(step: WorkflowStep, state: WorkflowRunState, input: WorkflowInput): string {
  if (hasTemplateVars(step.prompt)) {
    return resolveTemplate(step.prompt, state.variables);
  }

  return [
    step.prompt.trim(),
    "",
    `Task: ${input.taskName}`,
    `Repository working directory: ${state.variables.workdir}`,
    "Task context from Notion page body (authoritative):",
    state.variables.task_context,
  ].join("\n");
}

async function runStepWithPolicy(input: {
  sessionKey: string;
  agent: string;
  message: string;
  retries?: number;
  timeout?: number;
  workdir?: string;
}): Promise<{ output: string; attempts: number }> {
  const meta = await describeAgent(input.agent);
  const retries = input.retries ?? meta.retries;
  const timeout = input.timeout ?? meta.timeout;
  const totalAttempts = Math.max(1, retries + 1);
  let lastErr: unknown;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      const output = await executeAgent(input.agent, {
        prompt: input.message,
        session_id: input.sessionKey,
        timeout,
        workdir: input.workdir,
      });
      return { output, attempts: attempt };
    } catch (err) {
      lastErr = err;
      if (attempt >= totalAttempts) break;
    }
  }

  throw new Error(
    `step_failed agent=${input.agent} attempts=${totalAttempts}: ${String(lastErr)}`,
  );
}

function notionStatusForStep(step: WorkflowStep, index: number): "plan" | "build" {
  if (index === 0) return "plan";
  return "build";
}

async function executeFromStep(
  client: NotionClient,
  workflow: WorkflowDefinition,
  input: WorkflowInput,
  state: WorkflowRunState,
): Promise<WorkflowRunState> {
  const steps = workflow.steps;

  for (let i = state.currentStepIndex; i < steps.length; i++) {
    const step = steps[i];
    state.currentStepIndex = i;

    const notionStatus = notionStatusForStep(step, i);
    if (notionStatus === "plan") {
      await client.markTaskPlanStarted(input.pageId, `Running step: ${step.id}`);
    } else {
      await client.markTaskBuildStarted(input.pageId, `Running step: ${step.id}`);
    }

    const prompt = resolveStepPrompt(step, state, input);

    let output: string;
    let attempts: number;
    let stepFailed = false;

    try {
      const result = await runStepWithPolicy({
        sessionKey: input.sessionKey,
        agent: step.agent,
        message: prompt,
        retries: step.retries,
        timeout: step.timeout,
        workdir: state.variables.workdir,
      });
      output = result.output;
      attempts = result.attempts;
    } catch (err) {
      output = String(err);
      attempts = (step.retries ?? 1) + 1;
      stepFailed = true;
    }

    state.stepResults.push({
      stepId: step.id,
      output,
      status: stepFailed ? "failed" : "success",
      attempts,
    });

    state.variables[`step_${step.id}_output`] = output;

    if (!stepFailed) {
      const kvPairs = parseKeyValueOutput(output);
      for (const [key, value] of Object.entries(kvPairs)) {
        state.variables[`${step.id}_${key}`] = value;
      }
    }

    await client.appendMarkdownSection(
      input.pageId,
      stepFailed ? `Step: ${step.id} (failed)` : `Step: ${step.id}`,
      output,
    );

    const statusDirective = parseStatusDirective(output);
    let transition: string;

    if (statusDirective) {
      transition = statusDirective;
    } else if (stepFailed) {
      transition = step.on_fail ?? "blocked";
    } else {
      transition = step.on_success ?? "next";
    }

    if (transition === "retry") {
      transition = "blocked";
    }

    if (transition === "done") {
      state.status = "done";
      await saveRunState(input.pageId, state);
      await client.markTaskDone(input.pageId, `Completed at step: ${step.id}`);
      return state;
    }

    if (transition === "blocked") {
      state.status = "blocked";
      state.blockedAtStepId = step.id;
      state.blockedReason = stepFailed ? `Step ${step.id} failed after ${attempts} attempt(s)` : `Blocked at step ${step.id}`;
      await saveRunState(input.pageId, state);
      await client.markTaskBlocked(
        input.pageId,
        state.blockedReason,
        `Workflow blocked at step: ${step.id}`,
      );
      return state;
    }

    if (transition === "failed") {
      state.status = "failed";
      state.blockedAtStepId = step.id;
      state.blockedReason = `Permanent failure at step ${step.id}`;
      await saveRunState(input.pageId, state);
      await client.markTaskBlocked(
        input.pageId,
        state.blockedReason,
        `Workflow permanently failed at step: ${step.id}`,
      );
      return state;
    }

    await saveRunState(input.pageId, state);
  }

  state.status = "done";
  await saveRunState(input.pageId, state);
  await client.markTaskDone(input.pageId, "Workflow completed all steps");
  return state;
}
