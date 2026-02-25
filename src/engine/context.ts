import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths } from "../config/paths.js";

export type StepResult = {
  stepId: string;
  output: string;
  status: "success" | "failed";
  attempts: number;
};

export type WorkflowRunStatus = "running" | "blocked" | "done" | "failed";

export type WorkflowRunState = {
  workflowId: string;
  currentStepIndex: number;
  status: WorkflowRunStatus;
  stepResults: StepResult[];
  variables: Record<string, string>;
  blockedAtStepId?: string;
  blockedReason?: string;
  updatedAt: string;
};

function stateDir() {
  return process.env.WORKFLOW_STATE_DIR ?? paths.workflowState;
}

function stateFilePath(pageId: string) {
  return path.join(stateDir(), `${pageId}.json`);
}

export async function saveRunState(pageId: string, state: WorkflowRunState): Promise<void> {
  const filePath = stateFilePath(pageId);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const data = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + "\n";
  await writeFile(tmpPath, data, "utf8");
  await rename(tmpPath, filePath);
}

export async function loadRunState(pageId: string): Promise<WorkflowRunState | null> {
  try {
    const raw = await readFile(stateFilePath(pageId), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.workflowId) return null;
    return parsed as WorkflowRunState;
  } catch {
    return null;
  }
}

export function createInitialState(workflowId: string): WorkflowRunState {
  return {
    workflowId,
    currentStepIndex: 0,
    status: "running",
    stepResults: [],
    variables: {},
    updatedAt: new Date().toISOString(),
  };
}
