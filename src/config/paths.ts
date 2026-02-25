import path from "node:path";
import { mkdir } from "node:fs/promises";

const CONFIG_ROOT = path.join(process.env.HOME ?? "~", ".config", "notionflow");

export const paths = {
  root:           CONFIG_ROOT,
  config:         path.join(CONFIG_ROOT, "config.json"),
  boards:         path.join(CONFIG_ROOT, "boards.json"),
  workflows:      path.join(CONFIG_ROOT, "workflows"),
  agents:         path.join(CONFIG_ROOT, "agents"),
  runs:           path.join(CONFIG_ROOT, "runs.json"),
  workflowState:  path.join(CONFIG_ROOT, "workflow-state"),
  boardState:     (boardId: string) => path.join(CONFIG_ROOT, "boards", boardId),
};

export async function ensureConfigDirs() {
  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.workflows, { recursive: true });
  await mkdir(paths.agents, { recursive: true });
  await mkdir(paths.workflowState, { recursive: true });
  await mkdir(path.join(CONFIG_ROOT, "boards"), { recursive: true });
}
