import {spawn} from 'node:child_process'
import {existsSync, readFileSync} from 'node:fs'
import {mkdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {afterEach, describe, expect, it} from 'vitest'
import {notionToken} from '../src/config/env'
import {notionGetPage, pageState} from '../src/services/notion'
import {createTempProjectFixture, type TempProjectFixture} from './helpers/projectFixture'

loadDotEnv()

const hasLiveNotionEnv =
  Boolean(notionToken()) && process.env.NOTIONFLOW_RUN_LIVE_E2E === '1'

describe('canonical end live e2e', () => {
  let fixture: TempProjectFixture | null = null

  afterEach(async () => {
    if (!fixture) return
    await fixture.cleanup()
    fixture = null
  })

  it.skipIf(!hasLiveNotionEnv)(
    'syncs terminal done/blocked/failed states to Notion task State',
    async () => {
      fixture = await createTempProjectFixture('notionflow-end-live-')
      await execCli(['init'], fixture.projectDir)

      const canonicalModuleUrl = pathToFileURL(
        path.resolve(process.cwd(), 'src/factory/canonical.ts'),
      ).href
      const factoriesDir = path.join(fixture.projectDir, 'factories')
      await mkdir(factoriesDir, {recursive: true})

      const scenarios = [
        {status: 'done', factoryId: 'end-live-done'},
        {status: 'blocked', factoryId: 'end-live-blocked'},
        {status: 'failed', factoryId: 'end-live-failed'},
      ] as const

      for (const {factoryId, status} of scenarios) {
        await writeFile(
          path.join(factoriesDir, `${factoryId}.ts`),
          terminalFactorySource(canonicalModuleUrl, factoryId, status),
          'utf8',
        )
      }

      await writeFile(
        path.join(fixture.projectDir, 'notionflow.config.ts'),
        projectConfigSource(
          scenarios.map(({factoryId}) => `./factories/${factoryId}.ts`),
        ),
        'utf8',
      )

      const boardId = `end-live-${Date.now()}`
      await execCli(
        [
          'integrations',
          'notion',
          'provision-board',
          '--board',
          boardId,
          '--title',
          `End Live ${boardId}`,
        ],
        fixture.projectDir,
      )

      const token = notionToken()
      if (!token) {
        throw new Error('NOTION_API_TOKEN is required for live end e2e')
      }

      for (const {factoryId, status} of scenarios) {
        const created = await execCli(
          [
            'integrations',
            'notion',
            'create-task',
            '--board',
            boardId,
            '--factory',
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

        const syncedState = await waitForPageState(token, taskExternalId, status)
        expect(syncedState).toBe(status)
      }
    },
    240_000,
  )
})

async function waitForPageState(
  token: string,
  pageId: string,
  expected: 'done' | 'blocked' | 'failed',
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
  return [
    `import {definePipe, end} from ${JSON.stringify(canonicalModuleUrl)};`,
    '',
    'const compiled = definePipe({',
    `  id: ${JSON.stringify(factoryId)},`,
    '  start: "terminal",',
    '  context: {},',
    '  states: {',
    `    terminal: end({status: ${JSON.stringify(status)}}),`,
    '  },',
    '});',
    '',
    'export default compiled.factory;',
    '',
  ].join('\n')
}

function projectConfigSource(factoryPaths: string[]): string {
  return [
    'export default {',
    '  factories: [',
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
          `Command failed (${code ?? -1}): notionflow ${args.join(' ')}\n${stderr}`,
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
