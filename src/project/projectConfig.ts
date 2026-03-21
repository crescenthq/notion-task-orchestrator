import path from 'node:path'
import {access, constants, readdir, stat} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import {z} from 'zod'
import {loadFactoryFromPath} from '../core/factory'
import type {LoadedFactoryDefinition} from '../core/factory'

const pipeDeclarationSchema = z.string().trim().min(1)

const projectConfigInputSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    pipes: z.array(pipeDeclarationSchema).optional(),
  })
  .strict()

const projectConfigSchema = projectConfigInputSchema.transform(config => ({
  name: config.name,
  pipes: config.pipes ?? [],
}))

const DEFAULT_FACTORY_DIRECTORY = './pipes'
const FACTORY_MODULE_FILE_PATTERN =
  /^(?!.*\.d\.(?:cts|mts|ts)$).+\.(?:cts|mts|ts|cjs|mjs|js)$/

export type PipeDeclaration = z.output<typeof pipeDeclarationSchema>
export type ProjectConfigInput = z.input<typeof projectConfigInputSchema>
export type ProjectConfig = z.output<typeof projectConfigSchema>

export type LoadedDeclaredPipe = {
  declaredSource: string
  resolvedPath: string
  definition: LoadedFactoryDefinition
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
    const details = parsed.error.issues
      .map(issue => {
        const issuePath =
          issue.path.length > 0 ? issue.path.join('.') : '<root>'
        return `${issuePath}: ${issue.message}`
      })
      .join('\n')

    throw new ProjectConfigLoadError(
      `Invalid project config: ${resolvedConfigPath}\n${details}`,
      resolvedConfigPath,
    )
  }

  return parsed.data
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
      const loaded = await loadFactoryFromPath(resolvedPath)
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
      : ([DEFAULT_FACTORY_DIRECTORY] satisfies PipeDeclaration[])
  const allowMissingDefaultDirectory = config.pipes.length === 0

  const resolvedEntries: ResolvedPipePath[] = []
  for (const declaration of declarations) {
    const resolvedDeclaration = await resolvePipeDeclaration(
      declaration,
      projectRoot,
      {
        allowMissing:
          allowMissingDefaultDirectory &&
          declaration === DEFAULT_FACTORY_DIRECTORY,
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
    if (!FACTORY_MODULE_FILE_PATTERN.test(relativePath)) {
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
