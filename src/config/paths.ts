import path from "node:path";

export const RUNTIME_DIR = ".notionflow";

export type RuntimePaths = {
  projectRoot: string;
  root: string;
  db: string;
  agentsDir: string;
  workflowsDir: string;
  runtimeLog: string;
  errorsLog: string;
};

export function resolveRuntimePaths(projectRoot: string): RuntimePaths {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const runtimeRoot = path.join(resolvedProjectRoot, RUNTIME_DIR);

  return {
    projectRoot: resolvedProjectRoot,
    root: runtimeRoot,
    db: path.join(runtimeRoot, "notionflow.db"),
    agentsDir: path.join(runtimeRoot, "agents"),
    workflowsDir: path.join(runtimeRoot, "workflows"),
    runtimeLog: path.join(runtimeRoot, "runtime.log"),
    errorsLog: path.join(runtimeRoot, "errors.log"),
  };
}

const defaultProjectRoot = path.resolve(process.env.NOTIONFLOW_PROJECT_ROOT ?? process.cwd());

export const paths = resolveRuntimePaths(defaultProjectRoot);
