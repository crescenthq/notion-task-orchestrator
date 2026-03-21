import path from 'node:path'

export const RUNTIME_DIR = '.pipes-runtime'

export type RuntimePaths = {
  projectRoot: string
  root: string
  db: string
  agentsDir: string
  workflowsDir: string
  workspaceMirrorsDir: string
  workspaceManifestsDir: string
  workspacesDir: string
  runtimeLog: string
  errorsLog: string
}

export function resolveRuntimePaths(projectRoot: string): RuntimePaths {
  const resolvedProjectRoot = path.resolve(projectRoot)
  const runtimeRoot = path.join(resolvedProjectRoot, RUNTIME_DIR)

  return {
    projectRoot: resolvedProjectRoot,
    root: runtimeRoot,
    db: path.join(runtimeRoot, 'pipes.db'),
    agentsDir: path.join(runtimeRoot, 'agents'),
    workflowsDir: path.join(runtimeRoot, 'workflows'),
    workspaceMirrorsDir: path.join(runtimeRoot, 'workspace-mirrors'),
    workspaceManifestsDir: path.join(runtimeRoot, 'workspace-manifests'),
    workspacesDir: path.join(runtimeRoot, 'workspaces'),
    runtimeLog: path.join(runtimeRoot, 'runtime.log'),
    errorsLog: path.join(runtimeRoot, 'errors.log'),
  }
}

const defaultProjectRoot = path.resolve(
  process.env.PIPES_PROJECT_ROOT ?? process.cwd(),
)

export const paths = resolveRuntimePaths(defaultProjectRoot)
