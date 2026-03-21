import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
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
  resume?: boolean
}

export type CleanupRunWorkspaceOptions = {
  paths: RuntimePaths
  projectRoot: string
  runId: string
}

export type PruneWorkspaceArtifactsOptions = {
  paths: RuntimePaths
  projectRoot: string
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
    runId,
    resume: options.resume ?? false,
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

export async function cleanupRunWorkspace(
  options: CleanupRunWorkspaceOptions,
): Promise<boolean> {
  const runId = normalizeRunId(options.runId)
  await ensureWorkspaceRuntimeDirs(options.paths)

  const manifestPath = path.join(
    options.paths.workspaceManifestsDir,
    `${runId}.json`,
  )
  const defaultWorktreePath = path.join(options.paths.workspacesDir, runId)
  const manifest = await loadRunWorkspaceManifest(manifestPath)
  const worktreePath = manifest?.root ?? defaultWorktreePath

  const hasManifest = manifest !== null
  const hasWorktree = await pathExists(worktreePath)
  if (!hasManifest && !hasWorktree) {
    return false
  }

  if (manifest?.mirrorPath) {
    await removeManagedWorktree({
      mirrorPath: manifest.mirrorPath,
      worktreePath,
      projectRoot: options.projectRoot,
    })
  } else if (hasWorktree) {
    await rm(worktreePath, {recursive: true, force: true})
  }

  await rm(worktreePath, {recursive: true, force: true})
  await rm(manifestPath, {force: true})
  return true
}

export async function pruneWorkspaceArtifacts(
  options: PruneWorkspaceArtifactsOptions,
): Promise<void> {
  await ensureWorkspaceRuntimeDirs(options.paths)

  const managedMirrorPaths = await listManagedMirrorPaths(
    options.paths.workspaceMirrorsDir,
  )
  const liveManagedWorktrees = new Set<string>()
  for (const mirrorPath of managedMirrorPaths) {
    await pruneManagedMirror({
      mirrorPath,
      projectRoot: options.projectRoot,
    })

    const worktrees = await listManagedWorktrees(
      mirrorPath,
      options.projectRoot,
    )
    for (const worktreePath of worktrees) {
      liveManagedWorktrees.add(worktreePath)
    }
  }

  const referencedRunIds = await listReferencedWorkspaceRunIds(
    options.paths.workspaceManifestsDir,
  )
  const workspaceEntries = await readdir(options.paths.workspacesDir, {
    withFileTypes: true,
  })

  for (const entry of workspaceEntries) {
    const workspacePath = path.join(options.paths.workspacesDir, entry.name)
    const canonicalWorkspacePath = await realpath(workspacePath).catch(() =>
      path.resolve(workspacePath),
    )
    if (
      liveManagedWorktrees.has(canonicalWorkspacePath) ||
      referencedRunIds.has(entry.name)
    ) {
      continue
    }

    await rm(workspacePath, {recursive: true, force: true})
  }
}

async function ensureWorkspaceRuntimeDirs(paths: RuntimePaths): Promise<void> {
  await mkdir(paths.workspaceMirrorsDir, {recursive: true})
  await mkdir(paths.workspaceManifestsDir, {recursive: true})
  await mkdir(paths.workspacesDir, {recursive: true})
}

async function loadRunWorkspaceManifest(
  manifestPath: string,
): Promise<{mirrorPath: string; root: string} | null> {
  if (!(await pathExists(manifestPath))) {
    return null
  }

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (
      !isRecord(manifest) ||
      typeof manifest.mirrorPath !== 'string' ||
      manifest.mirrorPath.trim().length === 0 ||
      typeof manifest.root !== 'string' ||
      manifest.root.trim().length === 0
    ) {
      throw new Error('workspace manifest is missing required mirrorPath/root')
    }

    return {
      mirrorPath: manifest.mirrorPath,
      root: manifest.root,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new WorkspaceProvisionError(
      [
        `Failed to load run workspace manifest: ${manifestPath}`,
        `fs: ${reason}`,
      ].join('\n'),
    )
  }
}

async function listManagedMirrorPaths(
  workspaceMirrorsDir: string,
): Promise<string[]> {
  const entries = await readdir(workspaceMirrorsDir, {withFileTypes: true})
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(workspaceMirrorsDir, entry.name))
}

async function listReferencedWorkspaceRunIds(
  workspaceManifestsDir: string,
): Promise<Set<string>> {
  const entries = await readdir(workspaceManifestsDir, {withFileTypes: true})
  return new Set(
    entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name.slice(0, -'.json'.length)),
  )
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

async function pruneManagedMirror(options: {
  mirrorPath: string
  projectRoot: string
}): Promise<void> {
  try {
    await runGit(
      ['--git-dir', options.mirrorPath, 'worktree', 'prune', '--expire=now'],
      options.projectRoot,
    )
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new WorkspaceProvisionError(
      [
        `Failed to prune managed workspace registrations.`,
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
  runId: string
  resume: boolean
}): Promise<void> {
  const worktreeExists = await pathExists(options.worktreePath)
  if (!worktreeExists) {
    if (options.resume) {
      throw new WorkspaceProvisionError(
        [
          `Run workspace is missing for resumed run \`${options.runId}\`.`,
          `runId: ${options.runId}`,
          `worktreePath: ${options.worktreePath}`,
          'Resume requires the original workspace; restore it or start a new run instead.',
        ].join('\n'),
      )
    }

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
  const canonicalWorktreePath = await realpath(options.worktreePath).catch(() =>
    path.resolve(options.worktreePath),
  )
  if (!managedWorktrees.has(canonicalWorktreePath)) {
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
    const worktreePaths = output
      .split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice('worktree '.length))
    const canonicalPaths = await Promise.all(
      worktreePaths.map(worktreePath =>
        realpath(worktreePath).catch(() => path.resolve(worktreePath)),
      ),
    )
    return new Set(canonicalPaths)
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

async function removeManagedWorktree(options: {
  mirrorPath: string
  worktreePath: string
  projectRoot: string
}): Promise<void> {
  const mirrorExists = await pathExists(options.mirrorPath)
  if (!mirrorExists) {
    await rm(options.worktreePath, {recursive: true, force: true})
    return
  }

  await pruneManagedMirror({
    mirrorPath: options.mirrorPath,
    projectRoot: options.projectRoot,
  })

  const managedWorktrees = await listManagedWorktrees(
    options.mirrorPath,
    options.projectRoot,
  )
  const canonicalWorktreePath = await realpath(options.worktreePath).catch(() =>
    path.resolve(options.worktreePath),
  )

  if (managedWorktrees.has(canonicalWorktreePath)) {
    try {
      await runGit(
        [
          '--git-dir',
          options.mirrorPath,
          'worktree',
          'remove',
          '--force',
          options.worktreePath,
        ],
        options.projectRoot,
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new WorkspaceProvisionError(
        [
          `Failed to remove run workspace worktree.`,
          `worktreePath: ${options.worktreePath}`,
          `mirrorPath: ${options.mirrorPath}`,
          `git: ${reason}`,
        ].join('\n'),
      )
    }
  }

  await pruneManagedMirror({
    mirrorPath: options.mirrorPath,
    projectRoot: options.projectRoot,
  })
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
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
