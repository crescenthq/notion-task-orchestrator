import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { paths } from "../config/paths.js";

export type WorkflowStep = {
  id: string;
  agent: string;
  prompt: string;
  on_success?: "next" | "done" | "blocked";
  on_fail?: "retry" | "blocked" | "failed";
  retries?: number;
  timeout?: number;
};

export type WorkflowDefinition = {
  id: string;
  name: string;
  description?: string;
  workdir?: string;
  steps: WorkflowStep[];
};

export function workflowsDir() {
  return process.env.WORKFLOWS_DIR ?? paths.workflows;
}

export async function listWorkflowFiles(dir = workflowsDir()) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && (e.name.endsWith(".yaml") || e.name.endsWith(".yml") || e.name.endsWith(".json")))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

export async function loadWorkflow(filePath: string): Promise<WorkflowDefinition> {
  const raw = await readFile(filePath, "utf8");
  const parsed = filePath.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw);
  return parsed as WorkflowDefinition;
}

export function validateWorkflowDefinition(input: WorkflowDefinition) {
  const errors: string[] = [];

  if (!input?.id?.trim()) errors.push("workflow.id is required");
  if (!input?.name?.trim()) errors.push("workflow.name is required");
  if (!Array.isArray(input?.steps) || input.steps.length === 0) {
    errors.push("workflow.steps must be a non-empty array");
  }

  const stepIds = new Set<string>();
  for (const [index, step] of (input?.steps ?? []).entries()) {
    const ptr = `steps[${index}]`;
    if (!step?.id?.trim()) errors.push(`${ptr}.id is required`);
    if (!step?.agent?.trim()) errors.push(`${ptr}.agent is required`);
    if (!step?.prompt?.trim()) errors.push(`${ptr}.prompt is required`);

    if (step?.id) {
      if (stepIds.has(step.id)) errors.push(`${ptr}.id must be unique (${step.id})`);
      stepIds.add(step.id);
    }

    if (step?.retries !== undefined) {
      if (!Number.isInteger(step.retries) || step.retries < 0 || step.retries > 10) {
        errors.push(`${ptr}.retries must be integer between 0 and 10`);
      }
    }

    if (step?.timeout !== undefined) {
      if (!Number.isInteger(step.timeout) || step.timeout <= 0 || step.timeout > 7200) {
        errors.push(`${ptr}.timeout must be positive integer up to 7200`);
      }
    }

    if (step?.on_success && !["next", "done", "blocked"].includes(step.on_success)) {
      errors.push(`${ptr}.on_success must be one of: next|done|blocked`);
    }

    if (step?.on_fail && !["retry", "blocked", "failed"].includes(step.on_fail)) {
      errors.push(`${ptr}.on_fail must be one of: retry|blocked|failed`);
    }
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

export async function loadAndValidateWorkflow(filePath: string) {
  const workflow = await loadWorkflow(filePath);
  const validation = validateWorkflowDefinition(workflow);
  return { workflow, validation };
}
