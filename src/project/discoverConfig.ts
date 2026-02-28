import {access, stat} from 'node:fs/promises'
import path from 'node:path'

const PROJECT_CONFIG_FILE = 'notionflow.config.ts'

export type ResolvedProjectConfig = {
  projectRoot: string
  configPath: string
}

export type ResolveProjectConfigOptions = {
  startDir?: string
  configPath?: string
}

export class ProjectConfigResolutionError extends Error {
  readonly startDir: string
  readonly attemptedPath?: string

  constructor(
    message: string,
    options: {startDir: string; attemptedPath?: string},
  ) {
    super(message)
    this.name = 'ProjectConfigResolutionError'
    this.startDir = options.startDir
    this.attemptedPath = options.attemptedPath
  }
}

export async function resolveProjectConfig(
  options: ResolveProjectConfigOptions = {},
): Promise<ResolvedProjectConfig> {
  const startDir = path.resolve(options.startDir ?? process.cwd())
  const explicitConfigPath = options.configPath?.trim()
  if (explicitConfigPath) {
    const resolvedExplicitPath = path.resolve(startDir, explicitConfigPath)
    const validatedPath = await validateConfigPath(
      resolvedExplicitPath,
      startDir,
    )
    return {
      projectRoot: path.dirname(validatedPath),
      configPath: validatedPath,
    }
  }

  const discovered = await discoverProjectConfig(startDir)
  if (discovered) {
    return discovered
  }

  throw new ProjectConfigResolutionError(
    'Could not find notionflow.config.ts by walking up from the current directory.',
    {startDir},
  )
}

export async function discoverProjectConfig(
  startDir: string = process.cwd(),
): Promise<ResolvedProjectConfig | null> {
  let currentDir = path.resolve(startDir)

  while (true) {
    const candidate = path.join(currentDir, PROJECT_CONFIG_FILE)
    if (await pathExists(candidate)) {
      return {
        projectRoot: currentDir,
        configPath: candidate,
      }
    }

    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) {
      return null
    }

    currentDir = parentDir
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

async function validateConfigPath(
  configPath: string,
  startDir: string,
): Promise<string> {
  try {
    const configStat = await stat(configPath)
    if (!configStat.isFile()) {
      throw new ProjectConfigResolutionError(
        'Provided --config path is not a file.',
        {
          startDir,
          attemptedPath: configPath,
        },
      )
    }

    return configPath
  } catch (error) {
    if (error instanceof ProjectConfigResolutionError) {
      throw error
    }

    throw new ProjectConfigResolutionError(
      'Provided --config path does not exist.',
      {
        startDir,
        attemptedPath: configPath,
      },
    )
  }
}
