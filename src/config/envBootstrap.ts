import path from 'node:path'
import {
  discoverProjectConfig,
  resolveProjectConfig,
} from '../project/discoverConfig'
import {z} from 'zod'

type BootstrapOptions = {
  startDir?: string
  configPath?: string
}

type RuntimeEnv = {
  NOTION_API_TOKEN?: string
  NOTION_WORKSPACE_PAGE_ID?: string
  NOTIONFLOW_PROJECT_ROOT?: string
}

const nonEmpty = z.string().trim().min(1)
const RuntimeEnvSchema = z.object({
  NOTION_API_TOKEN: nonEmpty.optional(),
  NOTION_WORKSPACE_PAGE_ID: nonEmpty.optional(),
  NOTIONFLOW_PROJECT_ROOT: nonEmpty.optional(),
})

function getArgValue(argv: string[], flag: string): string | null {
  const fromArgvPrefix = argv.find(item => item.startsWith(`${flag}=`))
  if (fromArgvPrefix) {
    return fromArgvPrefix.slice(`${flag}=`.length)
  }

  const flagIndex = argv.indexOf(flag)
  const nextValue = flagIndex >= 0 ? argv[flagIndex + 1] : undefined
  if (
    flagIndex >= 0 &&
    typeof nextValue === 'string' &&
    nextValue.trim().length > 0 &&
    !nextValue.startsWith('--')
  ) {
    return nextValue
  }

  return null
}

function getExplicitEnvFile(argv: string[]): string | null {
  return getArgValue(argv, '--env-file')
}

export function inferConfigPathFromArgv(argv: string[]): string | null {
  return getArgValue(argv, '--config')
}

function loadEnvFile(filePath: string): boolean {
  try {
    if (typeof process.loadEnvFile !== 'function') {
      throw new Error('Node build-in env loader is unavailable in this runtime.')
    }

    process.loadEnvFile(filePath)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false
    }

    throw error
  }
}

function validateRuntimeEnv(): void {
  const parsed = RuntimeEnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map(issue => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new Error(`Invalid environment configuration: ${details}`)
  }

  const normalized = parsed.data as RuntimeEnv
  for (const [key, value] of Object.entries(normalized)) {
    if (value !== undefined) {
      process.env[key] = value
    }
  }
}

export async function bootstrapRuntimeEnv(
  options: BootstrapOptions = {},
): Promise<void> {
  const startDir = options.startDir ?? process.cwd()
  const envFile = getExplicitEnvFile(process.argv)
  const explicitConfigPath =
    options.configPath?.trim() || inferConfigPathFromArgv(process.argv)
  const candidatePaths: string[] = []

  if (envFile) {
    candidatePaths.push(path.resolve(startDir, envFile))
  }

  let resolvedConfigDir: string | null = null

  if (explicitConfigPath) {
    try {
      const resolvedProject = await resolveProjectConfig({
        startDir,
        configPath: explicitConfigPath,
      })
      resolvedConfigDir = path.dirname(resolvedProject.configPath)
    } catch {
      // ignore --config resolution failures during env bootstrap
    }
  }

  if (!resolvedConfigDir) {
    try {
      const discoveredProject = await discoverProjectConfig(startDir)
      if (discoveredProject) {
        resolvedConfigDir = path.dirname(discoveredProject.configPath)
      }
    } catch {
      // ignore discovery failures during env bootstrap
    }
  }

  if (resolvedConfigDir) {
    candidatePaths.push(path.join(resolvedConfigDir, '.env'))
  }

  candidatePaths.push(path.join(startDir, '.env'))

  for (const candidate of candidatePaths) {
    if (loadEnvFile(candidate)) {
      break
    }
  }

  validateRuntimeEnv()
}
