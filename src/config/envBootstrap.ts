import path from 'node:path'
import {discoverProjectConfig} from '../project/discoverConfig'
import {z} from 'zod'

type BootstrapOptions = {
  startDir?: string
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

function getExplicitEnvFile(argv: string[]): string | null {
  const fromArgvPrefix = argv.find(item => item.startsWith('--env-file='))
  if (fromArgvPrefix) {
    return fromArgvPrefix.slice('--env-file='.length)
  }

  const envFileIndex = argv.indexOf('--env-file')
  if (envFileIndex >= 0 && argv[envFileIndex + 1]) {
    return argv[envFileIndex + 1]
  }

  return null
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
  const candidatePaths: string[] = []

  if (envFile) {
    candidatePaths.push(path.resolve(startDir, envFile))
  }

  try {
    const resolvedProject = await discoverProjectConfig(startDir)
    if (resolvedProject) {
      candidatePaths.push(path.join(path.dirname(resolvedProject.configPath), '.env'))
    }
  } catch {
    // ignore discovery failures during env bootstrap
  }

  candidatePaths.push(path.join(startDir, '.env'))

  for (const candidate of candidatePaths) {
    if (loadEnvFile(candidate)) {
      break
    }
  }

  validateRuntimeEnv()
}
