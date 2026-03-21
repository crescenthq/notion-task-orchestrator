import {existsSync} from 'node:fs'
import path from 'node:path'

export const RUNTIME_DIR = '.pipes-runtime'
const RUNTIME_DB = 'pipes.db'
const LEGACY_RUNTIME_DIR = '.notionflow'
const LEGACY_RUNTIME_DB = 'notionflow.db'

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
  const runtimeLayout = resolveRuntimeLayout(resolvedProjectRoot)
  const runtimeRoot = path.join(resolvedProjectRoot, runtimeLayout.dir)

  return {
    projectRoot: resolvedProjectRoot,
    root: runtimeRoot,
    db: path.join(runtimeRoot, runtimeLayout.db),
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

function resolveRuntimeLayout(projectRoot: string): {
  dir: string
  db: string
} {
  const runtimeRoot = path.join(projectRoot, RUNTIME_DIR)
  const legacyRuntimeRoot = path.join(projectRoot, LEGACY_RUNTIME_DIR)

  // Keep reading the legacy runtime until a project has explicitly created
  // the renamed runtime root.
  if (existsSync(legacyRuntimeRoot) && !existsSync(runtimeRoot)) {
    return {
      dir: LEGACY_RUNTIME_DIR,
      db: LEGACY_RUNTIME_DB,
    }
  }

  return {
    dir: RUNTIME_DIR,
    db: RUNTIME_DB,
  }
}
