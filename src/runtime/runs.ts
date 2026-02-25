import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths } from "../config/paths.js";

export type RunStatus = "queued" | "in_progress" | "blocked" | "done" | "failed" | "dry_run";

export type RunEvent = {
  at: string;
  message: string;
};

export type RunRecord = {
  runId: string;
  boardId: string;
  workflowId: string;
  taskPageId?: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  events: RunEvent[];
};

export type RunStore = {
  version: 1;
  runs: RunRecord[];
};

const DEFAULT_STORE: RunStore = {
  version: 1,
  runs: []
};

export function runStorePath() {
  return process.env.RUN_STORE_FILE ?? paths.runs;
}

async function ensureParent(filePath: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
}

export async function loadRunStore(filePath = runStorePath()): Promise<RunStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as RunStore;
    if (!Array.isArray(parsed?.runs)) throw new Error("Invalid run store: runs must be an array");
    return { version: 1, runs: parsed.runs };
  } catch (err: any) {
    if (err?.code === "ENOENT") return { ...DEFAULT_STORE };
    throw err;
  }
}

export async function saveRunStore(store: RunStore, filePath = runStorePath()) {
  await ensureParent(filePath);
  await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export async function upsertRun(run: RunRecord, filePath = runStorePath()) {
  const store = await loadRunStore(filePath);
  const idx = store.runs.findIndex((r) => r.runId === run.runId);
  if (idx >= 0) store.runs[idx] = run;
  else store.runs.unshift(run);
  await saveRunStore(store, filePath);
  return run;
}

export async function getRun(runId: string, filePath = runStorePath()) {
  const store = await loadRunStore(filePath);
  return store.runs.find((r) => r.runId === runId) ?? null;
}

export async function appendRunEvent(runId: string, message: string, filePath = runStorePath()) {
  const store = await loadRunStore(filePath);
  const run = store.runs.find((r) => r.runId === runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const now = new Date().toISOString();
  run.events.push({ at: now, message });
  run.updatedAt = now;
  await saveRunStore(store, filePath);
  return run;
}
