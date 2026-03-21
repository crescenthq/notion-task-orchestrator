import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir, realpath, stat, writeFile} from 'node:fs/promises'
import path from 'node:path'
import type {RuntimePaths} from '../config/paths'
import type {ResolvedWorkspaceConfig} from '../project/projectConfig'

const WORKSPACE_MANIFEST_VERSION = 1

export type RunWorkspaceManifest = {
  version: typeof WORKSPACE_MANIFEST_VERSION
  runId: string
  source: ResolvedWorkspaceConfig['source']
  repo: string
  requestedRef: string
  ref: string
  cleanup: ResolvedWorkspaceConfig['cleanup']
  root: string
  cwd: string
  relativeCwd: string
  mirrorPath: string
  createdAt: string
}

export type ProvisionedRunWorkspace = RunWorkspaceManifest & {
  manifestPath: string
}

export type ProvisionRunWorkspaceOptions = {
  paths: RuntimePaths
  projectRoot: string
  workspace: ResolvedWorkspaceConfig
  runId: string
}

export class WorkspaceProvisionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceProvisionError'
  }
}

export async function provisionRunWorkspace(
  options: ProvisionRunWorkspaceOptions,
): Promise<ProvisionedRunWorkspace> {
  const projectRoot = path.resolve(options.projectRoot)
  const canonicalProjectRoot = await realpath(projectRoot).catch(
    () => projectRoot,
  )
  const runId = normalizeRunId(options.runId)
  await ensureWorkspaceRuntimeDirs(options.paths)

  const sourceRepo = await resolveWorkspaceSourceRepo({
    repo: options.workspace.repo,
    projectRoot,
  })
  const mirrorPath = path.join(
    options.paths.workspaceMirrorsDir,
    `${buildManagedMirrorName(sourceRepo)}.git`,
  )
  await ensureManagedMirror({
    sourceRepo,
    mirrorPath,
    projectRoot,
  })

  const requestedRef = options.workspace.ref
  const resolvedTargetRef = await resolveMirrorRef({
    requestedRef,
    mirrorPath,
    projectRoot,
    sourceRepo,
  })

  const worktreePath = path.join(options.paths.workspacesDir, runId)
  await ensureManagedWorktree({
    mirrorPath,
    worktreePath,
    targetRef: resolvedTargetRef,
    projectRoot,
  })

  const root = await resolveWorktreeRoot(worktreePath, projectRoot)
  const {cwd, relativeCwd} = resolveWorkspaceCwd({
    worktreeRoot: root,
    projectRoot: canonicalProjectRoot,
    repoRoot: sourceRepo,
    workspace: options.workspace,
  })
  await assertWorkspaceDirectory(cwd, {
    relativeCwd,
    root,
  })

  const ref = await resolveWorktreeHead(root, projectRoot)
  const manifestPath = path.join(
    options.paths.workspaceManifestsDir,
    `${runId}.json`,
  )
  const manifest: ProvisionedRunWorkspace = {
    version: WORKSPACE_MANIFEST_VERSION,
    runId,
    source: options.workspace.source,
    repo: sourceRepo,
    requestedRef,
    ref,
    cleanup: options.workspace.cleanup,
    root,
    cwd,
    relativeCwd,
    mirrorPath,
    createdAt: new Date().toISOString(),
    manifestPath,
  }

  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  )
  return manifest
}

async function ensureWorkspaceRuntimeDirs(paths: RuntimePaths): Promise<void> {
  await mkdir(paths.workspaceMirrorsDir, {recursive: true})
  await mkdir(paths.workspaceManifestsDir, {recursive: true})
  await mkdir(paths.workspacesDir, {recursive: true})
}

async function resolveWorkspaceSourceRepo(options: {
  repo: string
  projectRoot: string
}): Promise<string> {
  if (looksLikeRemoteRepoSpecifier(options.repo)) {
    return options.repo
  }

  try {
    const repoRoot = await runGit(
      ['-C', options.repo, 'rev-parse', '--show-toplevel'],
      options.projectRoot,
    )
    return await realpath(repoRoot).catch(() => path.resolve(repoRoot))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new WorkspaceProvisionError(
      [
        `Workspace source is not a readable git repo: ${options.repo}`,
        `projectRoot: ${options.projectRoot}`,
        `git: ${reason}`,
      ].join('\n'),
    )
  }
}

async function ensureManagedMirror(options: {
  sourceRepo: string
  mirrorPath: string
  projectRoot: string
}): Promise<void> {
  const mirrorExists = await pathExists(options.mirrorPath)
  if (!mirrorExists) {
    try {
      await runGit(
        ['clone', '--mirror', options.sourceRepo, options.mirrorPath],
        options.projectRoot,
      )
      return
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new WorkspaceProvisionError(
        [
          `Failed to create managed mirror for workspace source: ${options.sourceRepo}`,
          `mirrorPath: ${options.mirrorPath}`,
          `git: ${reason}`,
        ].join('\n'),
      )
    }
  }

  try {
    const bareValue = await runGit(
      ['--git-dir', options.mirrorPath, 'rev-parse', '--is-bare-repository'],
      options.projectRoot,
    )
    if (bareValue !== 'true') {
      throw new Error(`expected bare repository, received ${bareValue}`)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new WorkspaceProvisionError(
      [
        `Managed mirror path is invalid: ${options.mirrorPath}`,
        `sourceRepo: ${options.sourceRepo}`,
        `git: ${reason}`,
      ].join('\n'),
    )
  }

  try {
    await runGit(
      [
        '--git-dir',
        options.mirrorPath,
        'remote',
        'set-url',
        'origin',
        options.sourceRepo,
      ],
      options.projectRoot,
    )
  } catch {
    try {
      await runGit(
        [
          '--git-dir',
          options.mirrorPath,
          'remote',
          'add',
          '--mirror=fetch',
          'origin',
          options.sourceRepo,
        ],
        options.projectRoot,
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new WorkspaceProvisionError(
        [
          `Failed to configure managed mirror remote for workspace source: ${options.sourceRepo}`,
          `mirrorPath: ${options.mirrorPath}`,
          `git: ${reason}`,
        ].join('\n'),
      )
    }
  }

  try {
    await runGit(
      ['--git-dir', options.mirrorPath, 'fetch', '--prune', 'origin'],
      options.projectRoot,
    )
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new WorkspaceProvisionError(
      [
        `Failed to update managed mirror for workspace source: ${options.sourceRepo}`,
        `mirrorPath: ${options.mirrorPath}`,
        `git: ${reason}`,
      ].join('\n'),
    )
  }
}

async function resolveMirrorRef(options: {
  requestedRef: string
  mirrorPath: string
  projectRoot: string
  sourceRepo: string
}): Promise<string> {
  try {
    return await runGit(
      [
        '--git-dir',
        options.mirrorPath,
        'rev-parse',
        '--verify',
        `${options.requestedRef}^{commit}`,
      ],
      options.projectRoot,
    )
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new WorkspaceProvisionError(
      [
        `Failed to resolve workspace ref \`${options.requestedRef}\`.`,
        `sourceRepo: ${options.sourceRepo}`,
        `mirrorPath: ${options.mirrorPath}`,
        `git: ${reason}`,
      ].join('\n'),
    )
  }
}

async function ensureManagedWorktree(options: {
  mirrorPath: string
  worktreePath: string
  targetRef: string
  projectRoot: string
}): Promise<void> {
  const worktreeExists = await pathExists(options.worktreePath)
  if (!worktreeExists) {
    try {
      await runGit(
        [
          '--git-dir',
          options.mirrorPath,
          'worktree',
          'add',
          '--detach',
          options.worktreePath,
          options.targetRef,
        ],
        options.projectRoot,
      )
      return
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new WorkspaceProvisionError(
        [
          `Failed to create run workspace worktree.`,
          `worktreePath: ${options.worktreePath}`,
          `mirrorPath: ${options.mirrorPath}`,
          `git: ${reason}`,
        ].join('\n'),
      )
    }
  }

  const managedWorktrees = await listManagedWorktrees(
    options.mirrorPath,
    options.projectRoot,
  )
  if (!managedWorktrees.has(path.resolve(options.worktreePath))) {
    throw new WorkspaceProvisionError(
      [
        `Run workspace path already exists but is not managed by the mirror.`,
        `worktreePath: ${options.worktreePath}`,
        `mirrorPath: ${options.mirrorPath}`,
      ].join('\n'),
    )
  }
}

async function listManagedWorktrees(
  mirrorPath: string,
  projectRoot: string,
): Promise<Set<string>> {
  try {
    const output = await runGit(
      ['--git-dir', mirrorPath, 'worktree', 'list', '--porcelain'],
      projectRoot,
    )
    return new Set(
      output
        .split('\n')
        .filter(line => line.startsWith('worktree '))
        .map(line => path.resolve(line.slice('worktree '.length))),
    )
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new WorkspaceProvisionError(
      [
        `Failed to inspect managed worktrees.`,
        `mirrorPath: ${mirrorPath}`,
        `git: ${reason}`,
      ].join('\n'),
    )
  }
}

async function resolveWorktreeRoot(
  worktreePath: string,
  projectRoot: string,
): Promise<string> {
  try {
    await runGit(
      ['-C', worktreePath, 'rev-parse', '--show-toplevel'],
      projectRoot,
    )
    return path.resolve(worktreePath)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new WorkspaceProvisionError(
      [
        `Run workspace is not a valid git worktree: ${worktreePath}`,
        `git: ${reason}`,
      ].join('\n'),
    )
  }
}

async function resolveWorktreeHead(
  worktreePath: string,
  projectRoot: string,
): Promise<string> {
  try {
    return await runGit(
      ['-C', worktreePath, 'rev-parse', '--verify', 'HEAD'],
      projectRoot,
    )
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new WorkspaceProvisionError(
      [
        `Failed to resolve run workspace HEAD: ${worktreePath}`,
        `git: ${reason}`,
      ].join('\n'),
    )
  }
}

function resolveWorkspaceCwd(options: {
  worktreeRoot: string
  projectRoot: string
  repoRoot: string
  workspace: ResolvedWorkspaceConfig
}): {cwd: string; relativeCwd: string} {
  const basePath =
    options.workspace.source === 'project'
      ? resolveProjectWorkspaceBasePath({
          worktreeRoot: options.worktreeRoot,
          projectRoot: options.projectRoot,
          repoRoot: options.repoRoot,
        })
      : options.worktreeRoot

  const cwd = path.resolve(basePath, options.workspace.cwd)
  const relativeCwd = toRelativeWorkspacePath(options.worktreeRoot, cwd)

  return {cwd, relativeCwd}
}

function resolveProjectWorkspaceBasePath(options: {
  worktreeRoot: string
  projectRoot: string
  repoRoot: string
}): string {
  const relativeProjectRoot = path.relative(
    options.repoRoot,
    options.projectRoot,
  )
  if (
    relativeProjectRoot.startsWith('..') ||
    path.isAbsolute(relativeProjectRoot)
  ) {
    throw new WorkspaceProvisionError(
      [
        'Project workspace root must stay inside the resolved git repo.',
        `projectRoot: ${options.projectRoot}`,
        `repoRoot: ${options.repoRoot}`,
      ].join('\n'),
    )
  }

  return path.resolve(options.worktreeRoot, relativeProjectRoot)
}

async function assertWorkspaceDirectory(
  targetPath: string,
  options: {relativeCwd: string; root: string},
): Promise<void> {
  try {
    const targetStat = await stat(targetPath)
    if (!targetStat.isDirectory()) {
      throw new Error('target exists but is not a directory')
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new WorkspaceProvisionError(
      [
        `Workspace cwd does not exist inside the checked out repo: ${options.relativeCwd}`,
        `workspaceRoot: ${options.root}`,
        `cwd: ${targetPath}`,
        `fs: ${reason}`,
      ].join('\n'),
    )
  }
}

function toRelativeWorkspacePath(root: string, targetPath: string): string {
  const relativePath = path.relative(root, targetPath)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new WorkspaceProvisionError(
      [
        `Workspace cwd resolves outside the checked out repo.`,
        `workspaceRoot: ${root}`,
        `cwd: ${targetPath}`,
      ].join('\n'),
    )
  }

  return relativePath.length > 0 ? relativePath : '.'
}

function normalizeRunId(runId: string): string {
  const trimmed = runId.trim()
  if (trimmed.length === 0) {
    throw new WorkspaceProvisionError(
      'Workspace runId must be a non-empty string.',
    )
  }

  if (trimmed.includes(path.sep) || trimmed.includes('/')) {
    throw new WorkspaceProvisionError(
      `Workspace runId must be a single path segment: ${runId}`,
    )
  }

  return trimmed
}

function buildManagedMirrorName(repo: string): string {
  const hash = createHash('sha256').update(repo).digest('hex').slice(0, 12)
  const readableBase = sanitizePathSegment(path.basename(repo, '.git'))
  return `${readableBase}-${hash}`
}

function sanitizePathSegment(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
  return cleaned.length > 0 ? cleaned : 'repo'
}

function looksLikeRemoteRepoSpecifier(repo: string): boolean {
  return (
    /^[a-z][a-z\d+.-]*:\/\//i.test(repo) || /^[^@/\s]+@[^:/\s]+:.+$/.test(repo)
  )
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }

    throw error
  }
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {cwd, encoding: 'utf8'}, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message))
        return
      }

      resolve(stdout.trim())
    })
  })
}
