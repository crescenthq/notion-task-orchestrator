import {execFile} from 'node:child_process'
import path from 'node:path'
import {access, constants, readdir, stat} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import {z} from 'zod'
import {loadPipeFromPath} from '../core/pipe'
import type {LoadedPipeDefinition} from '../core/pipe'

const pipeDeclarationSchema = z.string().trim().min(1)
const workspaceCleanupPolicySchema = z.enum(['on-success', 'never'])
const workspaceConfigObjectSchema = z
  .object({
    repo: z.string().trim().min(1).optional(),
    ref: z.string().trim().min(1).optional(),
    cwd: z.string().trim().min(1).optional(),
    cleanup: workspaceCleanupPolicySchema.optional(),
  })
  .strict()
const workspaceConfigInputSchema = z
  .string()
  .trim()
  .min(1)
  .or(workspaceConfigObjectSchema)

const projectConfigInputSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    pipes: z.array(pipeDeclarationSchema).optional(),
    workspace: workspaceConfigInputSchema.optional(),
  })
  .strict()

const projectConfigSchema = projectConfigInputSchema.transform(config => ({
  name: config.name,
  pipes: config.pipes ?? [],
  workspace: normalizeWorkspaceConfig(config.workspace),
}))

const DEFAULT_PIPE_DIRECTORY = './pipes'
const PIPE_MODULE_FILE_PATTERN =
  /^(?!.*\.d\.(?:cts|mts|ts)$).+\.(?:cts|mts|ts|cjs|mjs|js)$/

export type PipeDeclaration = z.output<typeof pipeDeclarationSchema>
export type WorkspaceCleanupPolicy = z.output<
  typeof workspaceCleanupPolicySchema
>
export type WorkspaceConfigInput = z.input<typeof workspaceConfigInputSchema>
export type ProjectConfigInput = z.input<typeof projectConfigInputSchema>
export type ProjectConfig = z.output<typeof projectConfigSchema>
export type ProjectWorkspaceConfig = {
  source: 'project'
  ref: string
  cwd: string
  cleanup: WorkspaceCleanupPolicy
}
export type ExplicitWorkspaceConfig = {
  source: 'repo'
  repo: string
  ref: string
  cwd: string
  cleanup: WorkspaceCleanupPolicy
}
export type WorkspaceConfig = ProjectWorkspaceConfig | ExplicitWorkspaceConfig
export type ResolvedProjectWorkspaceConfig = ProjectWorkspaceConfig & {
  repo: string
}
export type ResolvedWorkspaceConfig =
  | ResolvedProjectWorkspaceConfig
  | ExplicitWorkspaceConfig

export type LoadedDeclaredPipe = {
  declaredSource: string
  resolvedPath: string
  definition: LoadedPipeDefinition
}

type ResolvedPipePath = {
  declaredSource: string
  resolvedPath: string
}

export class ProjectConfigLoadError extends Error {
  readonly configPath: string

  constructor(message: string, configPath: string) {
    super(message)
    this.name = 'ProjectConfigLoadError'
    this.configPath = configPath
  }
}

class PipeDeclarationResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PipeDeclarationResolutionError'
  }
}

export function defineConfig(config: ProjectConfigInput): ProjectConfigInput {
  return config
}

export async function loadProjectConfig(
  configPath: string,
): Promise<ProjectConfig> {
  const resolvedConfigPath = path.resolve(configPath)
  const configModuleUrl = pathToFileURL(resolvedConfigPath)
  configModuleUrl.searchParams.set('nf', String(Date.now()))

  let loaded: unknown
  try {
    const mod = await import(configModuleUrl.href)
    loaded = (mod as {default?: unknown}).default
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ProjectConfigLoadError(
      `Failed to load project config module: ${resolvedConfigPath}\n${reason}`,
      resolvedConfigPath,
    )
  }

  const parsed = projectConfigSchema.safeParse(loaded)
  if (!parsed.success) {
    throw new ProjectConfigLoadError(
      [
        `Invalid project config: ${resolvedConfigPath}`,
        formatProjectConfigIssues(parsed.error),
      ].join('\n'),
      resolvedConfigPath,
    )
  }

  return parsed.data
}

export async function resolveWorkspaceConfig(options: {
  config: ProjectConfig
  projectRoot: string
  configPath: string
}): Promise<ResolvedWorkspaceConfig> {
  const resolvedProjectRoot = path.resolve(options.projectRoot)
  const resolvedConfigPath = path.resolve(options.configPath)

  if (options.config.workspace.source === 'repo') {
    return {
      ...options.config.workspace,
      repo: resolveWorkspaceRepoSpecifier(
        options.config.workspace.repo,
        resolvedProjectRoot,
      ),
    }
  }

  return {
    ...options.config.workspace,
    repo: await resolveProjectRepoRoot({
      projectRoot: resolvedProjectRoot,
      configPath: resolvedConfigPath,
    }),
  }
}

export async function resolvePipePaths(
  config: ProjectConfig,
  projectRoot: string,
): Promise<string[]> {
  const resolvedEntries = await resolveDeclaredPipePaths(config, projectRoot)
  return resolvedEntries.map(entry => entry.resolvedPath)
}

export async function loadDeclaredPipes(options: {
  configPath: string
  projectRoot: string
}): Promise<LoadedDeclaredPipe[]> {
  const resolvedConfigPath = path.resolve(options.configPath)
  const config = await loadProjectConfig(resolvedConfigPath)
  let resolvedPipePaths: ResolvedPipePath[]

  try {
    resolvedPipePaths = await resolveDeclaredPipePaths(
      config,
      options.projectRoot,
    )
  } catch (error) {
    if (error instanceof PipeDeclarationResolutionError) {
      throw new ProjectConfigLoadError(error.message, resolvedConfigPath)
    }

    throw error
  }

  const loadedPipes: LoadedDeclaredPipe[] = []
  const seenPipeIds = new Map<string, LoadedDeclaredPipe>()
  for (const {declaredSource, resolvedPath} of resolvedPipePaths) {
    try {
      await access(resolvedPath, constants.F_OK)
    } catch {
      throw new ProjectConfigLoadError(
        [
          `Declared pipe file does not exist: ${declaredSource}`,
          `Resolved path: ${resolvedPath}`,
        ].join('\n'),
        resolvedConfigPath,
      )
    }

    try {
      const loaded = await loadPipeFromPath(resolvedPath)
      const loadedEntry: LoadedDeclaredPipe = {
        declaredSource,
        resolvedPath,
        definition: loaded.definition,
      }

      const existing = seenPipeIds.get(loaded.definition.id)
      if (existing) {
        throw new ProjectConfigLoadError(
          [
            `Duplicate pipe id detected: ${loaded.definition.id}`,
            `First declaration: ${existing.declaredSource}`,
            `First resolved path: ${existing.resolvedPath}`,
            `Duplicate declaration: ${declaredSource}`,
            `Duplicate resolved path: ${resolvedPath}`,
          ].join('\n'),
          resolvedConfigPath,
        )
      }

      seenPipeIds.set(loaded.definition.id, loadedEntry)
      loadedPipes.push(loadedEntry)
    } catch (error) {
      if (error instanceof ProjectConfigLoadError) {
        throw error
      }

      const reason = error instanceof Error ? error.message : String(error)
      throw new ProjectConfigLoadError(
        [
          `Failed loading declared pipe path: ${declaredSource}`,
          `Resolved path: ${resolvedPath}`,
          reason,
        ].join('\n'),
        resolvedConfigPath,
      )
    }
  }

  return loadedPipes
}

async function resolveDeclaredPipePaths(
  config: ProjectConfig,
  projectRoot: string,
): Promise<ResolvedPipePath[]> {
  const declarations =
    config.pipes.length > 0
      ? config.pipes
      : ([DEFAULT_PIPE_DIRECTORY] satisfies PipeDeclaration[])
  const allowMissingDefaultDirectory = config.pipes.length === 0

  const resolvedEntries: ResolvedPipePath[] = []
  for (const declaration of declarations) {
    const resolvedDeclaration = await resolvePipeDeclaration(
      declaration,
      projectRoot,
      {
        allowMissing:
          allowMissingDefaultDirectory &&
          declaration === DEFAULT_PIPE_DIRECTORY,
      },
    )

    resolvedEntries.push(...resolvedDeclaration)
  }

  return dedupeResolvedPipePaths(resolvedEntries)
}

async function resolvePipeDeclaration(
  declaration: PipeDeclaration,
  projectRoot: string,
  options: {allowMissing: boolean},
): Promise<ResolvedPipePath[]> {
  const resolvedPath = resolveConfiguredPath(declaration, projectRoot)
  const targetType = await getPathType(resolvedPath)

  if (targetType === 'missing') {
    if (options.allowMissing) return []

    throw new PipeDeclarationResolutionError(
      [
        `Declared pipe path does not exist: ${declaration}`,
        `Resolved path: ${resolvedPath}`,
      ].join('\n'),
    )
  }

  if (targetType === 'directory') {
    return collectPipePathsFromDirectory(declaration, resolvedPath)
  }

  if (targetType !== 'file') {
    throw new PipeDeclarationResolutionError(
      [
        `Declared pipe path is not a file or directory: ${declaration}`,
        `Resolved path: ${resolvedPath}`,
      ].join('\n'),
    )
  }

  return [{declaredSource: declaration, resolvedPath}]
}

async function collectPipePathsFromDirectory(
  declaration: string,
  resolvedDirectory: string,
): Promise<ResolvedPipePath[]> {
  const resolvedPaths = await listPipeModulesInDirectory(resolvedDirectory)

  return resolvedPaths.map(resolvedPath => ({
    declaredSource: declaration,
    resolvedPath,
  }))
}

async function listPipeModulesInDirectory(
  directoryPath: string,
): Promise<string[]> {
  const entries = await readdir(directoryPath, {withFileTypes: true})
  entries.sort((left, right) => left.name.localeCompare(right.name))

  const resolvedPaths: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }

    const entryPath = path.join(directoryPath, entry.name)
    const relativePath = toPortableRelativePath(directoryPath, entryPath)
    if (!PIPE_MODULE_FILE_PATTERN.test(relativePath)) {
      continue
    }

    resolvedPaths.push(entryPath)
  }

  return resolvedPaths
}

async function getPathType(
  targetPath: string,
): Promise<'directory' | 'file' | 'missing' | 'other'> {
  try {
    const targetStat = await stat(targetPath)
    if (targetStat.isDirectory()) return 'directory'
    if (targetStat.isFile()) return 'file'
    return 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'missing'
    }

    throw error
  }
}

function resolveConfiguredPath(
  targetPath: string,
  projectRoot: string,
): string {
  return path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(projectRoot, targetPath)
}

function dedupeResolvedPipePaths(
  entries: ResolvedPipePath[],
): ResolvedPipePath[] {
  const uniqueEntries: ResolvedPipePath[] = []
  const seenPaths = new Set<string>()

  for (const entry of entries) {
    if (seenPaths.has(entry.resolvedPath)) {
      continue
    }

    seenPaths.add(entry.resolvedPath)
    uniqueEntries.push(entry)
  }

  return uniqueEntries
}

function toPortableRelativePath(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/')
}

function normalizeWorkspaceConfig(
  workspace: WorkspaceConfigInput | undefined,
): WorkspaceConfig {
  if (typeof workspace === 'string') {
    return {
      source: 'repo',
      repo: workspace,
      ref: 'HEAD',
      cwd: '.',
      cleanup: 'on-success',
    }
  }

  if (!workspace) {
    return {
      source: 'project',
      ref: 'HEAD',
      cwd: '.',
      cleanup: 'on-success',
    }
  }

  const ref = workspace.ref ?? 'HEAD'
  const cwd = workspace.cwd ?? '.'
  const cleanup = workspace.cleanup ?? 'on-success'

  if (workspace.repo) {
    return {
      source: 'repo',
      repo: workspace.repo,
      ref,
      cwd,
      cleanup,
    }
  }

  return {
    source: 'project',
    ref,
    cwd,
    cleanup,
  }
}

function formatProjectConfigIssues(error: z.ZodError): string {
  const issues = flattenProjectConfigIssues(error.issues)
  const seenIssues = new Set<string>()
  const lines: string[] = []

  for (const issue of issues) {
    const issuePath =
      issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>'
    const line = `${issuePath}: ${issue.message}`
    if (seenIssues.has(line)) {
      continue
    }

    seenIssues.add(line)
    lines.push(line)
  }

  return lines.join('\n')
}

function flattenProjectConfigIssues(
  issues: z.ZodIssue[],
  parentPath: PropertyKey[] = [],
): Array<{path: PropertyKey[]; message: string}> {
  const flattened: Array<{path: PropertyKey[]; message: string}> = []

  for (const issue of issues) {
    const issuePath = [...parentPath, ...issue.path]
    if (issue.code === 'invalid_union') {
      flattened.push(
        ...issue.errors.flatMap(branch =>
          flattenProjectConfigIssues(branch, issuePath),
        ),
      )
      continue
    }

    flattened.push({path: issuePath, message: issue.message})
  }

  return flattened
}

async function resolveProjectRepoRoot(options: {
  projectRoot: string
  configPath: string
}): Promise<string> {
  try {
    const repoRoot = await runGitCommand(
      ['-C', options.projectRoot, 'rev-parse', '--show-toplevel'],
      options.projectRoot,
    )
    if (repoRoot.length === 0) {
      throw new Error('git did not report a repository root.')
    }

    return path.resolve(repoRoot)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ProjectConfigLoadError(
      [
        `Invalid project config: ${options.configPath}`,
        'workspace: default workspace mode requires the project root to be inside a git repo',
        `projectRoot: ${options.projectRoot}`,
        `git: ${reason}`,
      ].join('\n'),
      options.configPath,
    )
  }
}

function resolveWorkspaceRepoSpecifier(
  repo: string,
  projectRoot: string,
): string {
  if (looksLikeRemoteRepoSpecifier(repo)) {
    return repo
  }

  return path.resolve(projectRoot, repo)
}

function looksLikeRemoteRepoSpecifier(repo: string): boolean {
  return (
    /^[a-z][a-z\d+.-]*:\/\//i.test(repo) || /^[^@/\s]+@[^:/\s]+:.+$/.test(repo)
  )
}

function runGitCommand(args: string[], cwd: string): Promise<string> {
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
