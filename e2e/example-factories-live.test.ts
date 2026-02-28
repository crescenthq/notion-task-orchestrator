import {spawn} from 'node:child_process'
import {existsSync, readFileSync} from 'node:fs'
import {realpath, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {eq} from 'drizzle-orm'
import {afterEach, describe, expect, it} from 'vitest'
import {openApp} from '../src/app/context'
import {notionToken} from '../src/config/env'
import {tasks} from '../src/db/schema'
import {
  assertNoNewGlobalNotionflowWrites,
  createTempProjectFixture,
  snapshotGlobalNotionflowWrites,
  type TempProjectFixture,
} from './helpers/projectFixture'

loadDotEnv()

const hasLiveNotionEnv =
  Boolean(notionToken()) && process.env.NOTIONFLOW_RUN_LIVE_E2E === '1'

describe('example factories live e2e', () => {
  let fixture: TempProjectFixture | null = null

  afterEach(async () => {
    if (!fixture) return
    await fixture.cleanup()
    fixture = null
  })

  it.skipIf(!hasLiveNotionEnv)(
    'runs rewritten shared-helper-demo example through CLI run in live Notion mode',
    async () => {
      const before = await snapshotGlobalNotionflowWrites()
      fixture = await createTempProjectFixture('notionflow-example-live-')

      await execCli(['init'], fixture.projectDir)

      const exampleFactoryPath = path.resolve(
        process.cwd(),
        'example-factories',
        'factories',
        'shared-helper-demo.ts',
      )
      await writeFile(
        path.join(fixture.projectDir, 'notionflow.config.ts'),
        exampleConfigSource(exampleFactoryPath),
        'utf8',
      )

      const doctor = await execCli(['doctor'], fixture.projectDir)
      const resolvedProjectRoot = await realpath(fixture.projectDir)
      expect(doctor.stdout).toContain(`Project root: ${resolvedProjectRoot}`)

      const boardId = `example-live-${Date.now()}`
      await execCli(
        [
          'integrations',
          'notion',
          'provision-board',
          '--board',
          boardId,
          '--title',
          `Example Live ${boardId}`,
        ],
        fixture.projectDir,
      )

      const created = await execCli(
        [
          'integrations',
          'notion',
          'create-task',
          '--board',
          boardId,
          '--factory',
          'shared-helper-demo',
          '--title',
          'Shared helper example live task',
          '--status',
          'queue',
        ],
        fixture.projectDir,
      )
      const taskExternalId = extractTaskExternalId(created.stdout)

      await execCli(['run', '--task', taskExternalId], fixture.projectDir)
      await expect(readTaskState(fixture.projectDir, taskExternalId)).resolves.toBe(
        'done',
      )

      const after = await snapshotGlobalNotionflowWrites()
      assertNoNewGlobalNotionflowWrites(before, after)
    },
    180_000,
  )
})

async function execCli(
  args: string[],
  cwd: string,
): Promise<{stdout: string; stderr: string}> {
  const cliPath = path.resolve(process.cwd(), 'src/cli.ts')
  const tsxLoaderPath = path.resolve(
    process.cwd(),
    'node_modules',
    'tsx',
    'dist',
    'loader.mjs',
  )

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', tsxLoaderPath, cliPath, ...args],
      {
        cwd,
        stdio: 'pipe',
        env: process.env,
      },
    )

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })

    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })

    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolve({stdout, stderr})
        return
      }

      reject(
        new Error(
          `Command failed (${code ?? -1}): notionflow ${args.join(' ')}\n${stderr}`,
        ),
      )
    })
  })
}

async function readTaskState(
  projectRoot: string,
  taskExternalId: string,
): Promise<string> {
  const {db} = await openApp({projectRoot})
  const [task] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.externalTaskId, taskExternalId))

  if (!task) {
    throw new Error(`Task not found in local DB: ${taskExternalId}`)
  }

  return task.state
}

function exampleConfigSource(factoryPath: string): string {
  return [
    'export default {',
    `  factories: [${JSON.stringify(factoryPath)}],`,
    '};',
    '',
  ].join('\n')
}

function extractTaskExternalId(stdout: string): string {
  const match = stdout.match(/Task created:\s*([^\s]+)/)
  if (!match?.[1]) {
    throw new Error(`Unable to extract created task id from output:\n${stdout}`)
  }

  return match[1]
}

function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env')
  if (!existsSync(envPath)) return

  const raw = readFileSync(envPath, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex <= 0) continue

    const key = trimmed.slice(0, separatorIndex).trim()
    const value = trimmed.slice(separatorIndex + 1).trim()
    if (!process.env[key]) {
      process.env[key] = value
    }
  }
}
