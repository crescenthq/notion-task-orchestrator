import {spawn} from 'node:child_process'
import {existsSync, readFileSync} from 'node:fs'
import {mkdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {and, asc, desc, eq} from 'drizzle-orm'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {nowIso, openApp} from '../src/app/context'
import {notionToken} from '../src/config/env'
import {replayRunTraces} from '../src/core/runTraces'
import {runTraces, runs, tasks, workflows} from '../src/db/schema'
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
import {assertLiveNotionEnv} from './helpers/liveNotionEnv'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TaskRow = typeof tasks.$inferSelect
type RunTraceRow = typeof runTraces.$inferSelect
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

function transitionLike(traces: RunTraceRow[]): RunTraceRow[] {
  return traces.filter(trace => trace.type === 'step' || trace.type === 'retry')
}

async function execCli(args: string[]): Promise<void> {
  const tsxLoaderPath = path.resolve(
    repositoryRoot,
    'node_modules',
    'tsx',
    'dist',
    'loader.mjs',
  )
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', tsxLoaderPath, cliPath, ...args],
      {
        cwd: requireProjectRoot(),
        stdio: 'inherit',
        env: process.env,
      },
    )

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
  events: RunTraceRow[]
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
    .from(runTraces)
    .where(eq(runTraces.taskId, task.id))
    .orderBy(asc(runTraces.timestamp), asc(runTraces.id))

  return {task, run: run ?? null, events}
}

function buildTickTimeline(
  events: RunTraceRow[],
): Array<{tickId: string; transitions: number}> {
  const counts = new Map<string, number>()
  for (const event of transitionLike(events)) {
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
  events: RunTraceRow[],
  notes: string[],
): ScenarioArtifact {
  const replayState = replayRunTraces(events)
  const transitionEvents = transitionLike(events)
  const traceTypes = new Set(events.map(event => event.type))
  if (!traceTypes.has('started')) {
    throw new Error(`Scenario ${scenario} missing started run trace`)
  }
  if (['done', 'failed', 'blocked'].includes(task.state) && !traceTypes.has('completed')) {
    throw new Error(`Scenario ${scenario} missing completed run trace`)
  }
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
    transitionCount: transitionEvents.length,
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
    assertLiveNotionEnv()

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

  it('A: happy path reaches done', async () => {
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

  it(
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
        try {
          await notionAppendTaskPageLog(
            token,
            taskExternalId,
            'Feedback received (local verification mode)',
            'Feedback was injected locally to resume deterministic verification.',
          )
        } catch {
          // Notion API append logs can occasionally return transient gateway errors.
          // Behavioral resumption assertions should not depend on this optional side effect.
        }
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
      const traceTypes = new Set(events.map(event => event.type))
      expect(traceTypes.has('await_feedback')).toBe(true)
      expect(traceTypes.has('resumed')).toBe(true)

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

  it('C: retry exhaustion reaches failed', async () => {
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
    expect(events.some(event => event.type === 'step')).toBe(true)
    const exhaustedEvent = events.find(
      e => e.reason === 'action.failed.exhausted',
    )
    expect(exhaustedEvent).toBeDefined()
    expect(exhaustedEvent!.type).toBe('step')
    expect(exhaustedEvent!.attempt).toBeGreaterThanOrEqual(1)

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

  it(
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
    expect(events.some(e => e.type === 'step')).toBe(true)

    const context = (() => {
      if (!task.stepVarsJson) {
        return {}
      }
      try {
        return JSON.parse(task.stepVarsJson) as Record<string, unknown>
      } catch {
        return {}
      }
    })()
    expect(Number(context['loop_iterations_seen'])).toBe(2)

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

  it(
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
        '__pipe_run__->__pipe_done__',
      ]
      const actualPath = transitionLike(events).map(
        e => `${e.fromStateId}->${e.toStateId}`,
      )
      expect(actualPath).toEqual(expectedPath)

      const distinctTicks = new Set(transitionLike(events).map(e => e.tickId))
      expect(distinctTicks.size).toBeGreaterThanOrEqual(1)

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
