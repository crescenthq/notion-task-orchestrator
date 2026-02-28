import {spawn} from 'node:child_process'
import {existsSync, readFileSync} from 'node:fs'
import {mkdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {and, asc, desc, eq} from 'drizzle-orm'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {nowIso, openApp} from '../src/app/context'
import {notionToken} from '../src/config/env'
import {replayTransitionEvents} from '../src/core/transitionEvents'
import {runs, tasks, transitionEvents, workflows} from '../src/db/schema'
import {
  notionAppendTaskPageLog,
  notionPostComment,
  notionUpdateTaskPageState,
} from '../src/services/notion'
import {
  assertNoNewGlobalNotionflowWrites,
  createTempProjectFixture,
  snapshotGlobalNotionflowWrites,
  type FilesystemSnapshot,
  type TempProjectFixture,
} from './helpers/projectFixture'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TaskRow = typeof tasks.$inferSelect
type TransitionEventRow = typeof transitionEvents.$inferSelect
type RunRow = typeof runs.$inferSelect

type ScenarioArtifact = {
  scenario: string
  factoryId: string
  taskExternalId: string
  taskId: string
  runId: string | null
  finalState: string
  transitionCount: number
  tickTimeline: Array<{tickId: string; transitions: number}>
  replayTerminalState: string | null
  startedAt: string
  finishedAt: string
  notes: string[]
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env')
  if (!existsSync(envPath)) return

  const raw = readFileSync(envPath, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim()
    if (!process.env[key]) process.env[key] = value
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoStamp(input = new Date()): string {
  const y = input.getUTCFullYear()
  const m = String(input.getUTCMonth() + 1).padStart(2, '0')
  const d = String(input.getUTCDate()).padStart(2, '0')
  const hh = String(input.getUTCHours()).padStart(2, '0')
  const mm = String(input.getUTCMinutes()).padStart(2, '0')
  const ss = String(input.getUTCSeconds()).padStart(2, '0')
  return `${y}${m}${d}-${hh}${mm}${ss}`
}

async function execCli(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npx', ['tsx', cliPath, ...args], {
      cwd: requireProjectRoot(),
      stdio: 'inherit',
      env: process.env,
    })

    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new Error(
          `Command failed (${code ?? -1}): notionflow ${args.join(' ')}`,
        ),
      )
    })
  })
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function createTaskAndReadNewExternalId(
  boardId: string,
  factoryId: string,
  title: string,
): Promise<string> {
  const {db} = await openApp({projectRoot: requireProjectRoot()})
  const before = await db
    .select({id: tasks.id})
    .from(tasks)
    .where(and(eq(tasks.boardId, boardId), eq(tasks.workflowId, factoryId)))
  const beforeIds = new Set(before.map(row => row.id))

  await execCli([
    'integrations',
    'notion',
    'create-task',
    '--board',
    boardId,
    '--title',
    title,
    '--factory',
    factoryId,
    '--status',
    'queue',
  ])

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const after = await db
      .select({
        id: tasks.id,
        externalTaskId: tasks.externalTaskId,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .where(and(eq(tasks.boardId, boardId), eq(tasks.workflowId, factoryId)))
      .orderBy(desc(tasks.createdAt))

    const created = after.find(row => !beforeIds.has(row.id))
    if (created?.externalTaskId) return created.externalTaskId
    await sleep(300)
  }

  throw new Error(
    `Unable to detect newly created task for board=${boardId} factory=${factoryId}`,
  )
}

async function fetchTaskWithArtifacts(taskExternalId: string): Promise<{
  task: TaskRow
  run: RunRow | null
  events: TransitionEventRow[]
}> {
  const {db} = await openApp({projectRoot: requireProjectRoot()})
  const [task] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.externalTaskId, taskExternalId))
    .orderBy(desc(tasks.updatedAt))

  if (!task) throw new Error(`Task not found in local DB: ${taskExternalId}`)

  const [run] = await db
    .select()
    .from(runs)
    .where(eq(runs.taskId, task.id))
    .orderBy(desc(runs.startedAt))

  const events = await db
    .select()
    .from(transitionEvents)
    .where(eq(transitionEvents.taskId, task.id))
    .orderBy(asc(transitionEvents.timestamp), asc(transitionEvents.id))

  return {task, run: run ?? null, events}
}

function buildTickTimeline(
  events: TransitionEventRow[],
): Array<{tickId: string; transitions: number}> {
  const counts = new Map<string, number>()
  for (const event of events) {
    counts.set(event.tickId, (counts.get(event.tickId) ?? 0) + 1)
  }
  return [...counts.entries()].map(([tickId, transitions]) => ({
    tickId,
    transitions,
  }))
}

async function runTick(
  boardId: string,
  factoryId: string,
  maxTransitionsPerTick?: number,
): Promise<void> {
  const args = ['tick', '--board', boardId, '--factory', factoryId, '--run']
  if (typeof maxTransitionsPerTick === 'number') {
    args.push('--max-transitions-per-tick', String(maxTransitionsPerTick))
  }
  await execCli(args)
}

async function runSingleTask(
  taskExternalId: string,
  maxTransitionsPerTick?: number,
): Promise<void> {
  const args = ['run', '--task', taskExternalId]
  if (typeof maxTransitionsPerTick === 'number') {
    args.push('--max-transitions-per-tick', String(maxTransitionsPerTick))
  }
  await execCli(args)
}

async function runUntilState(
  boardId: string,
  factoryId: string,
  taskExternalId: string,
  states: string[],
  options?: {maxTicks?: number; maxTransitionsPerTick?: number},
): Promise<TaskRow> {
  const maxTicks = options?.maxTicks ?? 12

  for (let i = 0; i < maxTicks; i += 1) {
    await runTick(boardId, factoryId, options?.maxTransitionsPerTick)
    const {task} = await fetchTaskWithArtifacts(taskExternalId)
    if (states.includes(task.state)) return task
    await sleep(500)
  }

  const {task} = await fetchTaskWithArtifacts(taskExternalId)
  throw new Error(
    `Task ${taskExternalId} did not reach states [${states.join(', ')}] within ${maxTicks} ticks (current=${task.state})`,
  )
}

async function provisionNotionBoard(
  boardId: string,
  title: string,
): Promise<void> {
  const args = [
    'integrations',
    'notion',
    'provision-board',
    '--board',
    boardId,
    '--title',
    title,
  ]
  if (parentPage) {
    args.push('--parent-page', parentPage)
  }
  await execCli(args)
}

async function writeVerificationProjectConfig(
  projectRoot: string,
): Promise<void> {
  const factoryEntries = verificationFactories
    .map(fileName => path.join(repositoryRoot, 'e2e', 'factories', fileName))
    .map(absolutePath => `    ${JSON.stringify(absolutePath)},`)
    .join('\n')

  const configContent = [
    'export default {',
    '  factories: [',
    factoryEntries,
    '  ],',
    '};',
    '',
  ].join('\n')

  await writeFile(
    path.join(projectRoot, 'notionflow.config.ts'),
    configContent,
    'utf8',
  )
}

async function seedVerificationWorkflows(projectRoot: string): Promise<void> {
  const {db} = await openApp({projectRoot})
  const timestamp = nowIso()

  for (const fileName of verificationFactories) {
    const workflowId = fileName.replace(/\.ts$/, '')
    await db
      .insert(workflows)
      .values({
        id: workflowId,
        version: 1,
        definitionYaml: '{}',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoNothing()
  }
}

function requireProjectRoot(): string {
  if (!fixture) {
    throw new Error('Verification project fixture is not initialized')
  }

  return fixture.projectDir
}

function summarizeScenario(
  scenario: string,
  factoryId: string,
  startedAt: string,
  finishedAt: string,
  task: TaskRow,
  run: RunRow | null,
  events: TransitionEventRow[],
  notes: string[],
): ScenarioArtifact {
  const replayState = replayTransitionEvents(events)
  if (
    replayState &&
    ['done', 'failed', 'blocked', 'feedback'].includes(task.state) &&
    replayState !== task.state
  ) {
    throw new Error(
      `Scenario ${scenario} replay terminal state mismatch: replay=${replayState} task.state=${task.state}`,
    )
  }

  return {
    scenario,
    factoryId,
    taskExternalId: task.externalTaskId,
    taskId: task.id,
    runId: run?.id ?? null,
    finalState: task.state,
    transitionCount: events.length,
    tickTimeline: buildTickTimeline(events),
    replayTerminalState: replayState,
    startedAt,
    finishedAt,
    notes,
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

loadDotEnv()
const hasToken = !!notionToken()
const parentPage =
  process.env.NOTION_WORKSPACE_PAGE_ID ??
  process.env.NOTIONFLOW_VERIFY_PARENT_PAGE_ID
const artifacts: ScenarioArtifact[] = []
const runStartedAt = new Date()
const repositoryRoot = path.resolve(process.cwd())
const cliPath = path.resolve(repositoryRoot, 'src/cli.ts')
const verificationFactories = [
  'verify-happy.ts',
  'verify-feedback.ts',
  'verify-retry-failure.ts',
  'verify-loop.ts',
  'verify-resume-budget.ts',
]

let fixture: TempProjectFixture | null = null
let globalWritesBefore: FilesystemSnapshot | null = null

describe('Live factory verification', () => {
  beforeAll(async () => {
    if (!hasToken) {
      return
    }

    globalWritesBefore = await snapshotGlobalNotionflowWrites()
    fixture = await createTempProjectFixture('notionflow-live-verify-')
    await execCli(['init'])
    await writeVerificationProjectConfig(requireProjectRoot())
    await seedVerificationWorkflows(requireProjectRoot())
  })

  afterAll(async () => {
    if (artifacts.length > 0) {
      const summary = {
        generatedAt: new Date().toISOString(),
        durationSeconds: Math.floor(
          (Date.now() - runStartedAt.getTime()) / 1000,
        ),
        passedScenarios: artifacts.length,
        artifacts,
      }

      const stamp = isoStamp(runStartedAt)
      const outDir = path.resolve('e2e/artifacts')
      await mkdir(outDir, {recursive: true})
      const outputPath = path.join(
        outDir,
        `factory-live-verification-${stamp}.json`,
      )
      await writeFile(
        outputPath,
        JSON.stringify(summary, null, 2) + '\n',
        'utf8',
      )
      console.log(`Artifact: ${outputPath}`)
    }

    if (globalWritesBefore) {
      const globalWritesAfter = await snapshotGlobalNotionflowWrites()
      assertNoNewGlobalNotionflowWrites(globalWritesBefore, globalWritesAfter)
    }

    if (fixture) {
      await fixture.cleanup()
      fixture = null
    }
  })

  it.skipIf(!hasToken)('A: happy path reaches done', async () => {
    const scenario = 'A_happy'
    const factoryId = 'verify-happy'
    const boardId = `${factoryId}-${isoStamp()}`.toLowerCase()
    const startedAt = new Date().toISOString()

    await provisionNotionBoard(boardId, `NotionFlow ${boardId}`)
    const taskExternalId = await createTaskAndReadNewExternalId(
      boardId,
      factoryId,
      `A happy path ${isoStamp()}`,
    )
    const task = await runUntilState(
      boardId,
      factoryId,
      taskExternalId,
      ['done'],
      {maxTicks: 6},
    )
    const {run, events} = await fetchTaskWithArtifacts(taskExternalId)

    expect(task.state).toBe('done')
    expect(events.length).toBeGreaterThanOrEqual(1)

    artifacts.push(
      summarizeScenario(
        scenario,
        factoryId,
        startedAt,
        new Date().toISOString(),
        task,
        run,
        events,
        [],
      ),
    )
  })

  it.skipIf(!hasToken)(
    'B: feedback path pauses then resumes to done',
    async () => {
      const scenario = 'B_feedback'
      const factoryId = 'verify-feedback'
      const boardId = `${factoryId}-${isoStamp()}`.toLowerCase()
      const startedAt = new Date().toISOString()

      await provisionNotionBoard(boardId, `NotionFlow ${boardId}`)
      const taskExternalId = await createTaskAndReadNewExternalId(
        boardId,
        factoryId,
        `B feedback path ${isoStamp()}`,
      )

      const paused = await runUntilState(
        boardId,
        factoryId,
        taskExternalId,
        ['feedback'],
        {
          maxTicks: 6,
        },
      )
      const token = notionToken()!
      const feedbackMode =
        process.env.NOTIONFLOW_VERIFY_FEEDBACK_MODE ?? 'local'

      if (feedbackMode === 'notion-comment') {
        await notionPostComment(
          token,
          taskExternalId,
          `Automated verification feedback reply ${isoStamp()}`,
        )
        await sleep(1500)
      } else if (feedbackMode === 'local') {
        const {db} = await openApp({projectRoot: requireProjectRoot()})
        const existingCtx = paused.stepVarsJson
          ? (JSON.parse(paused.stepVarsJson) as Record<string, unknown>)
          : {}
        const resumedCtx = {
          ...existingCtx,
          human_feedback: 'approved-by-local-resume',
        }
        await db
          .update(tasks)
          .set({
            state: 'queued',
            stepVarsJson: JSON.stringify(resumedCtx),
            waitingSince: null,
            updatedAt: nowIso(),
          })
          .where(eq(tasks.id, paused.id))
        await notionUpdateTaskPageState(token, taskExternalId, 'queued')
        await notionAppendTaskPageLog(
          token,
          taskExternalId,
          'Feedback received (local verification mode)',
          'Feedback was injected locally to resume deterministic verification.',
        )
      } else {
        throw new Error(
          `Unsupported NOTIONFLOW_VERIFY_FEEDBACK_MODE=${feedbackMode}. Use notion-comment|local`,
        )
      }

      const task = await runUntilState(
        boardId,
        factoryId,
        taskExternalId,
        ['done'],
        {maxTicks: 8},
      )
      const {run, events} = await fetchTaskWithArtifacts(taskExternalId)

      expect(paused.state).toBe('feedback')
      expect(task.state).toBe('done')
      const eventNames = new Set(events.map(e => e.event))
      expect(eventNames.has('feedback')).toBe(true)
      expect(eventNames.has('done')).toBe(true)

      artifacts.push(
        summarizeScenario(
          scenario,
          factoryId,
          startedAt,
          new Date().toISOString(),
          task,
          run,
          events,
          [`feedback mode: ${feedbackMode}`],
        ),
      )
    },
  )

  it.skipIf(!hasToken)('C: retry exhaustion reaches failed', async () => {
    const scenario = 'C_retry_failure'
    const factoryId = 'verify-retry-failure'
    const boardId = `${factoryId}-${isoStamp()}`.toLowerCase()
    const startedAt = new Date().toISOString()

    await provisionNotionBoard(boardId, `NotionFlow ${boardId}`)
    const taskExternalId = await createTaskAndReadNewExternalId(
      boardId,
      factoryId,
      `C retry failure ${isoStamp()}`,
    )
    const task = await runUntilState(
      boardId,
      factoryId,
      taskExternalId,
      ['failed'],
      {
        maxTicks: 4,
      },
    )
    const {run, events} = await fetchTaskWithArtifacts(taskExternalId)

    expect(task.state).toBe('failed')
    const exhaustedEvent = events.find(
      e => e.reason === 'action.failed.exhausted',
    )
    expect(exhaustedEvent).toBeDefined()
    expect(exhaustedEvent!.attempt).toBeGreaterThanOrEqual(3)

    artifacts.push(
      summarizeScenario(
        scenario,
        factoryId,
        startedAt,
        new Date().toISOString(),
        task,
        run,
        events,
        [],
      ),
    )
  })

  it.skipIf(!hasToken)(
    'D: bounded loop reaches done with loop iterations',
    async () => {
      const scenario = 'D_bounded_loop'
      const factoryId = 'verify-loop'
      const boardId = `${factoryId}-${isoStamp()}`.toLowerCase()
      const startedAt = new Date().toISOString()

      await provisionNotionBoard(boardId, `NotionFlow ${boardId}`)
      const taskExternalId = await createTaskAndReadNewExternalId(
        boardId,
        factoryId,
        `D bounded loop ${isoStamp()}`,
      )
      const task = await runUntilState(
        boardId,
        factoryId,
        taskExternalId,
        ['done', 'failed'],
        {
          maxTicks: 4,
        },
      )
      const {run, events} = await fetchTaskWithArtifacts(taskExternalId)

      expect(task.state).toBe('done')
      expect(events.some(e => e.loopIteration > 0)).toBe(true)

      artifacts.push(
        summarizeScenario(
          scenario,
          factoryId,
          startedAt,
          new Date().toISOString(),
          task,
          run,
          events,
          [],
        ),
      )
    },
  )

  it.skipIf(!hasToken)(
    'E: resume replay matches exact transition path across ticks',
    async () => {
      const scenario = 'E_resume_replay'
      const factoryId = 'verify-resume-budget'
      const boardId = `${factoryId}-${isoStamp()}`.toLowerCase()
      const startedAt = new Date().toISOString()

      await provisionNotionBoard(boardId, `NotionFlow ${boardId}`)
      const taskExternalId = await createTaskAndReadNewExternalId(
        boardId,
        factoryId,
        `E resume replay ${isoStamp()}`,
      )

      for (let i = 0; i < 8; i += 1) {
        await runSingleTask(taskExternalId, 1)
        const {task} = await fetchTaskWithArtifacts(taskExternalId)
        if (task.state === 'done') break
      }

      const {task, run, events} = await fetchTaskWithArtifacts(taskExternalId)

      expect(task.state).toBe('done')

      const expectedPath = [
        'step_one->step_two',
        'step_two->step_three',
        'step_three->done',
      ]
      const actualPath = events.map(e => `${e.fromStateId}->${e.toStateId}`)
      expect(actualPath).toEqual(expectedPath)

      const distinctTicks = new Set(events.map(e => e.tickId))
      expect(distinctTicks.size).toBeGreaterThanOrEqual(3)

      artifacts.push(
        summarizeScenario(
          scenario,
          factoryId,
          startedAt,
          new Date().toISOString(),
          task,
          run,
          events,
          ['maxTransitionsPerTick=1', 'replay path exact-match'],
        ),
      )
    },
  )
})
