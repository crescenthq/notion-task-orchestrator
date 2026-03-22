import {spawn} from 'node:child_process'
import {existsSync, readFileSync} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import path from 'node:path'
import {afterAll, afterEach, describe, expect, it} from 'vitest'
import {notionToken} from '../src/config/env'
import {definePipe, write} from '../src/pipe/canonical'
import {
  notionGetPageMarkdown,
  notionReplacePageMarkdown,
} from '../src/services/notion'
import {
  createTempProjectFixture,
  type TempProjectFixture,
} from './helpers/projectFixture'
import {hasLiveNotionEnv} from './helpers/liveNotionEnv'
import {
  finishLiveBoardSuite,
  registerLiveBoardSuite,
  resolveSharedBoardConnection,
} from './helpers/sharedNotionBoard'
import {createMockTaskHandle} from './helpers/mockTaskHandle'
import {mockPipeWorkspace} from './helpers/mockPipeWorkspace'

loadDotEnv()
const liveSuiteEnabled = hasLiveNotionEnv()
if (liveSuiteEnabled) {
  registerLiveBoardSuite()
}

;(liveSuiteEnabled ? describe : describe.skip)(
  'canonical write live e2e',
  () => {
    let fixture: TempProjectFixture | null = null

    afterEach(async () => {
      if (!fixture) return
      await fixture.cleanup()
      fixture = null
    })

    afterAll(async () => {
      await finishLiveBoardSuite()
    })

    it('replaces the Notion task page artifact via the markdown api', async () => {
      fixture = await createTempProjectFixture('pipes-write-live-')
      await execCli(['init'], fixture.projectDir)
      await writeFile(
        path.join(fixture.projectDir, 'pipes.config.ts'),
        writeLiveConfigSource(),
        'utf8',
      )
      await writeFile(
        path.join(fixture.projectDir, 'pipes', 'write-live.ts'),
        writeLiveFactorySource(),
        'utf8',
      )

      const board = await resolveSharedBoardConnection()
      await execCli(
        ['integrations', 'notion', 'setup', '--url', board.url],
        fixture.projectDir,
      )

      const created = await execCli(
        [
          'integrations',
          'notion',
          'create-task',
          '--pipe',
          'write-live',
          '--title',
          'Canonical write live e2e task',
          '--status',
          'queue',
        ],
        fixture.projectDir,
      )
      const taskExternalId = extractTaskExternalId(created.stdout)
      const token = notionToken()
      if (!token) {
        throw new Error('NOTION_API_TOKEN is required for live write e2e')
      }

      const marker = `canonical-write-live-${Date.now()}`
      const writePipe = definePipe({
        id: 'write-live-e2e',
        initial: {score: 9},
        run: write<{score: number}>(ctx => ({
          markdown: `## ${marker}\n\nscore=${ctx.score}`,
        })),
      })

      const result = await writePipe.run({
        ctx: {score: 9},
        workspace: mockPipeWorkspace,
        runId: `run-${Date.now()}`,
        tickId: `tick-${Date.now()}`,
        task: createMockTaskHandle({
          id: taskExternalId,
          title: 'Canonical write live e2e task',
          writeArtifact: async markdown => {
            await notionReplacePageMarkdown(token, taskExternalId, markdown)
          },
        }),
      })

      expect(result).toEqual({score: 9})
      const body = await waitForPageBodyContains(token, taskExternalId, marker)
      expect(body).toContain('score=9')
    }, 180_000)
  },
)

async function waitForPageBodyContains(
  token: string,
  pageId: string,
  marker: string,
): Promise<string> {
  const maxAttempts = 10
  const delayMs = 1_000

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const body = await notionGetPageMarkdown(token, pageId)
    if (body.includes(marker)) {
      return body
    }
    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }

  throw new Error(
    `Timed out waiting for page ${pageId} to contain marker ${marker}`,
  )
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

function writeLiveConfigSource(): string {
  return [
    'export default {',
    '  pipes: ["./pipes/write-live.ts"],',
    '};',
    '',
  ].join('\n')
}

function writeLiveFactorySource(): string {
  return [
    'export default {',
    '  id: "write-live",',
    '  initial: {},',
    '  run: async ({ctx}) => ctx,',
    '}',
    '',
  ].join('\n')
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
