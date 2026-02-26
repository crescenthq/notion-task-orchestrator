import path from "node:path";

const HOME = process.env.HOME ?? process.cwd();
const CONFIG_ROOT = path.join(HOME, ".config", "notionflow");

export const paths = {
  root: CONFIG_ROOT,
  db: path.join(CONFIG_ROOT, "notionflow.db"),
  agentsDir: path.join(CONFIG_ROOT, "agents"),
  workflowsDir: path.join(CONFIG_ROOT, "workflows"),
};
