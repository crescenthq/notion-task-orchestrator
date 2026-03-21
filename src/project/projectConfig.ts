import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {access, constants, readdir, stat} from 'node:fs/promises'
import {z} from 'zod'
import {loadFactoryFromPath} from '../core/factory'
import type {LoadedFactoryDefinition} from '../core/factory'

const factoryDirectoryDeclarationSchema = z.object({
  directory: z.string().trim().min(1),
  match: z.instanceof(RegExp).optional(),
  recursive: z.boolean().optional(),
})

const factoryDeclarationSchema = z.union([
  z.string().trim().min(1),
  factoryDirectoryDeclarationSchema,
])

const projectConfigInputSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    pipes: z.array(factoryDeclarationSchema).optional(),
    factories: z.array(factoryDeclarationSchema).optional(),
  })
  .superRefine((config, ctx) => {
    if (config.pipes && config.factories) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['factories'],
        message: 'Use `pipes` or legacy `factories`, not both',
      })
    }
  })

const projectConfigSchema = projectConfigInputSchema.transform(config => ({
  name: config.name,
  pipes: config.pipes ?? config.factories ?? [],
}))

const DEFAULT_FACTORY_DIRECTORY = './pipes'
const FACTORY_MODULE_FILE_PATTERN =
  /^(?!.*\.d\.(?:cts|mts|ts)$).+\.(?:cts|mts|ts|cjs|mjs|js)$/

export type FactoryDeclaration = z.output<typeof factoryDeclarationSchema>
export type ProjectConfigInput = z.input<typeof projectConfigInputSchema>
export type ProjectConfig = z.output<typeof projectConfigSchema>

export type LoadedDeclaredFactory = {
  declaredSource: string
  resolvedPath: string
  definition: LoadedFactoryDefinition
}

type ResolvedFactoryPath = {
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

class FactoryDeclarationResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FactoryDeclarationResolutionError'
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

export async function resolveFactoryPaths(
  config: ProjectConfig,
  projectRoot: string,
): Promise<string[]> {
  const resolvedEntries = await resolveDeclaredFactoryPaths(config, projectRoot)
  return resolvedEntries.map(entry => entry.resolvedPath)
}

export async function loadDeclaredFactories(options: {
  configPath: string
  projectRoot: string
}): Promise<LoadedDeclaredFactory[]> {
  const resolvedConfigPath = path.resolve(options.configPath)
  const config = await loadProjectConfig(resolvedConfigPath)
  let resolvedFactoryPaths: ResolvedFactoryPath[]

  try {
    resolvedFactoryPaths = await resolveDeclaredFactoryPaths(
      config,
      options.projectRoot,
    )
  } catch (error) {
    if (error instanceof FactoryDeclarationResolutionError) {
      throw new ProjectConfigLoadError(error.message, resolvedConfigPath)
    }

    throw error
  }

  const loadedFactories: LoadedDeclaredFactory[] = []
  const seenFactoryIds = new Map<string, LoadedDeclaredFactory>()
  for (const {declaredSource, resolvedPath} of resolvedFactoryPaths) {
    try {
      await access(resolvedPath, constants.F_OK)
    } catch {
      throw new ProjectConfigLoadError(
        [
          `Declared factory file does not exist: ${declaredSource}`,
          `Resolved path: ${resolvedPath}`,
        ].join('\n'),
        resolvedConfigPath,
      )
    }

    try {
      const loaded = await loadFactoryFromPath(resolvedPath)
      const loadedEntry: LoadedDeclaredFactory = {
        declaredSource,
        resolvedPath,
        definition: loaded.definition,
      }

      const existing = seenFactoryIds.get(loaded.definition.id)
      if (existing) {
        throw new ProjectConfigLoadError(
          [
            `Duplicate factory id detected: ${loaded.definition.id}`,
            `First declaration: ${existing.declaredSource}`,
            `First resolved path: ${existing.resolvedPath}`,
            `Duplicate declaration: ${declaredSource}`,
            `Duplicate resolved path: ${resolvedPath}`,
          ].join('\n'),
          resolvedConfigPath,
        )
      }

      seenFactoryIds.set(loaded.definition.id, loadedEntry)
      loadedFactories.push(loadedEntry)
    } catch (error) {
      if (error instanceof ProjectConfigLoadError) {
        throw error
      }

      const reason = error instanceof Error ? error.message : String(error)
      throw new ProjectConfigLoadError(
        [
          `Failed loading declared factory path: ${declaredSource}`,
          `Resolved path: ${resolvedPath}`,
          reason,
        ].join('\n'),
        resolvedConfigPath,
      )
    }
  }

  return loadedFactories
}

async function resolveDeclaredFactoryPaths(
  config: ProjectConfig,
  projectRoot: string,
): Promise<ResolvedFactoryPath[]> {
  const declarations =
    config.pipes.length > 0
      ? config.pipes
      : ([DEFAULT_FACTORY_DIRECTORY] satisfies FactoryDeclaration[])
  const allowMissingDefaultDirectory = config.pipes.length === 0

  const resolvedEntries: ResolvedFactoryPath[] = []
  for (const declaration of declarations) {
    const resolvedDeclaration = await resolveFactoryDeclaration(
      declaration,
      projectRoot,
      {
        allowMissing:
          allowMissingDefaultDirectory &&
          typeof declaration === 'string' &&
          declaration === DEFAULT_FACTORY_DIRECTORY,
      },
    )

    resolvedEntries.push(...resolvedDeclaration)
  }

  return dedupeResolvedFactoryPaths(resolvedEntries)
}

async function resolveFactoryDeclaration(
  declaration: FactoryDeclaration,
  projectRoot: string,
  options: {allowMissing: boolean},
): Promise<ResolvedFactoryPath[]> {
  if (typeof declaration === 'string') {
    return resolveStringFactoryDeclaration(declaration, projectRoot, options)
  }

  return resolveDirectoryFactoryDeclaration(declaration, projectRoot, options)
}

async function resolveStringFactoryDeclaration(
  declaration: string,
  projectRoot: string,
  options: {allowMissing: boolean},
): Promise<ResolvedFactoryPath[]> {
  const resolvedPath = resolveConfiguredPath(declaration, projectRoot)
  const targetType = await getPathType(resolvedPath)

  if (targetType === 'missing') {
    if (options.allowMissing) return []

    throw new FactoryDeclarationResolutionError(
      [
        `Declared factory path does not exist: ${declaration}`,
        `Resolved path: ${resolvedPath}`,
      ].join('\n'),
    )
  }

  if (targetType === 'directory') {
    return collectFactoryPathsFromDirectory(
      {directory: declaration},
      projectRoot,
      declaration,
    )
  }

  if (targetType !== 'file') {
    throw new FactoryDeclarationResolutionError(
      [
        `Declared factory path is not a file or directory: ${declaration}`,
        `Resolved path: ${resolvedPath}`,
      ].join('\n'),
    )
  }

  return [{declaredSource: declaration, resolvedPath}]
}

async function resolveDirectoryFactoryDeclaration(
  declaration: z.output<typeof factoryDirectoryDeclarationSchema>,
  projectRoot: string,
  options: {allowMissing: boolean},
): Promise<ResolvedFactoryPath[]> {
  const resolvedDirectory = resolveConfiguredPath(
    declaration.directory,
    projectRoot,
  )
  const targetType = await getPathType(resolvedDirectory)

  if (targetType === 'missing') {
    if (options.allowMissing) return []

    throw new FactoryDeclarationResolutionError(
      [
        `Declared factory directory does not exist: ${declaration.directory}`,
        `Resolved path: ${resolvedDirectory}`,
      ].join('\n'),
    )
  }

  if (targetType !== 'directory') {
    throw new FactoryDeclarationResolutionError(
      [
        `Declared factory directory is not a directory: ${formatFactoryDeclaration(declaration)}`,
        `Resolved path: ${resolvedDirectory}`,
      ].join('\n'),
    )
  }

  return collectFactoryPathsFromDirectory(
    declaration,
    projectRoot,
    formatFactoryDeclaration(declaration),
  )
}

async function collectFactoryPathsFromDirectory(
  declaration: z.output<typeof factoryDirectoryDeclarationSchema>,
  projectRoot: string,
  declaredSource: string,
): Promise<ResolvedFactoryPath[]> {
  const resolvedDirectory = resolveConfiguredPath(
    declaration.directory,
    projectRoot,
  )
  const resolvedPaths = await walkFactoryDirectory(resolvedDirectory, {
    rootDirectory: resolvedDirectory,
    match: declaration.match,
    recursive: declaration.recursive ?? false,
  })

  return resolvedPaths.map(resolvedPath => ({
    declaredSource,
    resolvedPath,
  }))
}

async function walkFactoryDirectory(
  directoryPath: string,
  options: {
    rootDirectory: string
    match?: RegExp
    recursive: boolean
  },
): Promise<string[]> {
  const entries = await readdir(directoryPath, {withFileTypes: true})
  entries.sort((left, right) => left.name.localeCompare(right.name))

  const resolvedPaths: string[] = []
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name)

    if (entry.isDirectory()) {
      if (!options.recursive) continue
      resolvedPaths.push(...(await walkFactoryDirectory(entryPath, options)))
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    const relativePath = toPortableRelativePath(
      options.rootDirectory,
      entryPath,
    )
    if (!FACTORY_MODULE_FILE_PATTERN.test(relativePath)) {
      continue
    }
    if (options.match && !matchesFactoryPattern(relativePath, options.match)) {
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

function dedupeResolvedFactoryPaths(
  entries: ResolvedFactoryPath[],
): ResolvedFactoryPath[] {
  const uniqueEntries: ResolvedFactoryPath[] = []
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

function formatFactoryDeclaration(
  declaration: z.output<typeof factoryDirectoryDeclarationSchema>,
): string {
  const flags: string[] = []
  if (declaration.match) {
    flags.push(`match=${String(declaration.match)}`)
  }
  if (declaration.recursive) {
    flags.push('recursive=true')
  }

  return flags.length > 0
    ? `${declaration.directory} (${flags.join(', ')})`
    : declaration.directory
}

function matchesFactoryPattern(relativePath: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0
  return pattern.test(relativePath)
}

function toPortableRelativePath(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/')
}
