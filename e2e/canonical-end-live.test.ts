import {spawn} from 'node:child_process'
import {existsSync, readFileSync} from 'node:fs'
import {mkdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {afterAll, afterEach, describe, expect, it} from 'vitest'
import {notionToken} from '../src/config/env'
import {notionGetPage, pageState} from '../src/services/notion'
import {
  commitAll,
  createTempProjectFixture,
  initGitRepo,
  type TempProjectFixture,
} from './helpers/projectFixture'
import {hasLiveNotionEnv} from './helpers/liveNotionEnv'
import {
  finishLiveBoardSuite,
  registerLiveBoardSuite,
  resolveSharedBoardConnection,
} from './helpers/sharedNotionBoard'

loadDotEnv()
const liveSuiteEnabled = hasLiveNotionEnv()
if (liveSuiteEnabled) {
  registerLiveBoardSuite()
}

;(liveSuiteEnabled ? describe : describe.skip)('canonical end live e2e', () => {
  let fixture: TempProjectFixture | null = null

  afterEach(async () => {
    if (!fixture) return
    await fixture.cleanup()
    fixture = null
  })

  afterAll(async () => {
    await finishLiveBoardSuite()
  })

  it('syncs terminal done/blocked/failed outcomes to Notion task State', async () => {
    fixture = await createTempProjectFixture('pipes-end-live-')
    await execCli(['init'], fixture.projectDir)
    await initGitRepo(fixture.projectDir)

    const canonicalModuleUrl = pathToFileURL(
      path.resolve(process.cwd(), 'src/pipe/canonical.ts'),
    ).href
    const pipesDir = path.join(fixture.projectDir, 'pipes')
    await mkdir(pipesDir, {recursive: true})

    const scenarios = [
      {
        status: 'done',
        expectedPageState: 'done',
        factoryId: 'end-live-done',
      },
      {
        status: 'blocked',
        expectedPageState: 'needs input',
        factoryId: 'end-live-blocked',
      },
      {
        status: 'failed',
        expectedPageState: 'failed',
        factoryId: 'end-live-failed',
      },
    ] as const

    for (const {factoryId, status} of scenarios) {
      await writeFile(
        path.join(pipesDir, `${factoryId}.ts`),
        terminalFactorySource(canonicalModuleUrl, factoryId, status),
        'utf8',
      )
    }

    await writeFile(
      path.join(fixture.projectDir, 'pipes.config.ts'),
      projectConfigSource(
        scenarios.map(({factoryId}) => `./pipes/${factoryId}.ts`),
      ),
      'utf8',
    )
    await commitAll(fixture.projectDir, 'canonical end live fixture')

    const board = await resolveSharedBoardConnection()
    await execCli(
      ['integrations', 'notion', 'setup', '--url', board.url],
      fixture.projectDir,
    )

    const token = notionToken()
    if (!token) {
      throw new Error('NOTION_API_TOKEN is required for live end e2e')
    }

    for (const {factoryId, status, expectedPageState} of scenarios) {
      const created = await execCli(
        [
          'integrations',
          'notion',
          'create-task',
          '--pipe',
          factoryId,
          '--title',
          `Canonical end live ${status} ${Date.now()}`,
          '--status',
          'queue',
        ],
        fixture.projectDir,
      )
      const taskExternalId = extractTaskExternalId(created.stdout)

      await execCli(['run', '--task', taskExternalId], fixture.projectDir)

      const syncedState = await waitForPageState(
        token,
        taskExternalId,
        expectedPageState,
      )
      expect(syncedState).toBe(expectedPageState)
    }
  }, 240_000)
})

async function waitForPageState(
  token: string,
  pageId: string,
  expected: 'done' | 'needs input' | 'failed',
): Promise<string> {
  const maxAttempts = 12
  const delayMs = 1_000

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const state = pageState(await notionGetPage(token, pageId))
    if (state === expected) {
      return state
    }
    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }

  throw new Error(`Timed out waiting for page ${pageId} state=${expected}`)
}

function terminalFactorySource(
  canonicalModuleUrl: string,
  factoryId: string,
  status: 'done' | 'blocked' | 'failed',
): string {
  const endFactory =
    status === 'done'
      ? 'end.done()'
      : status === 'blocked'
        ? 'end.blocked()'
        : 'end.failed("terminal failed")'

  return [
    `import {definePipe, end} from ${JSON.stringify(canonicalModuleUrl)};`,
    '',
    'export default definePipe({',
    `  id: ${JSON.stringify(factoryId)},`,
    '  initial: {},',
    `  run: ${endFactory},`,
    '});',
    '',
  ].join('\n')
}

function projectConfigSource(factoryPaths: string[]): string {
  return [
    'export default {',
    '  pipes: [',
    ...factoryPaths.map(factoryPath => `    ${JSON.stringify(factoryPath)},`),
    '  ],',
    '};',
    '',
  ].join('\n')
}

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
          `Command failed (${code ?? -1}): pipes ${args.join(' ')}\n${stderr}`,
        ),
      )
    })
  })
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
