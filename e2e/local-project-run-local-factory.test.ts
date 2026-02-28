import {spawn} from 'node:child_process'
import {writeFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {eq} from 'drizzle-orm'
import {afterEach, describe, expect, it} from 'vitest'
import {nowIso, openApp} from '../src/app/context'
import {boards, runTraces, tasks, workflows} from '../src/db/schema'
import {
  assertNoNewGlobalNotionflowWrites,
  createTempProjectFixture,
  snapshotGlobalNotionflowWrites,
  type TempProjectFixture,
} from './helpers/projectFixture'

describe('local project run command', () => {
  let fixture: TempProjectFixture | null = null

  afterEach(async () => {
    if (!fixture) {
      return
    }

    await fixture.cleanup()
    fixture = null
  })

  it('loads factories directly from project config and picks up edits without install', async () => {
    const before = await snapshotGlobalNotionflowWrites()
    fixture = await createTempProjectFixture()

    await execCli(['init'], fixture.projectDir)

    const factoryPath = path.join(fixture.projectDir, 'factories', 'smoke.ts')
    const canonicalModuleUrl = pathToFileURL(
      path.resolve(process.cwd(), 'src/factory/canonical.ts'),
    ).href
    await writeFile(factoryPath, factorySource(canonicalModuleUrl, 'done'), 'utf8')
    await writeFile(
      path.join(fixture.projectDir, 'notionflow.config.ts'),
      configSource('./factories/smoke.ts'),
      'utf8',
    )

    const externalTaskId = `task-${crypto.randomUUID()}`
    await insertQueuedTask(fixture.projectDir, externalTaskId, 'smoke')

    await execCli(['run', '--task', externalTaskId], fixture.projectDir)
    await expect(
      readTaskState(fixture.projectDir, externalTaskId),
    ).resolves.toBe('done')

    await writeFile(factoryPath, factorySource(canonicalModuleUrl, 'failed'), 'utf8')
    await resetTaskToQueued(fixture.projectDir, externalTaskId)

    await execCli(['run', '--task', externalTaskId], fixture.projectDir)
    await expect(
      readTaskState(fixture.projectDir, externalTaskId),
    ).resolves.toBe('failed')

    const after = await snapshotGlobalNotionflowWrites()
    assertNoNewGlobalNotionflowWrites(before, after)
  })

  it('pauses on ask feedback and resumes to done in local mode', async () => {
    const before = await snapshotGlobalNotionflowWrites()
    fixture = await createTempProjectFixture()

    await execCli(['init'], fixture.projectDir)

    const factoryPath = path.join(
      fixture.projectDir,
      'factories',
      'ask-resume.ts',
    )
    const canonicalModuleUrl = pathToFileURL(
      path.resolve(process.cwd(), 'src/factory/canonical.ts'),
    ).href
    await writeFile(factoryPath, askResumeFactorySource(canonicalModuleUrl), 'utf8')
    await writeFile(
      path.join(fixture.projectDir, 'notionflow.config.ts'),
      configSource('./factories/ask-resume.ts'),
      'utf8',
    )

    const externalTaskId = `task-${crypto.randomUUID()}`
    await insertQueuedTask(fixture.projectDir, externalTaskId, 'ask-resume')

    await execCli(['run', '--task', externalTaskId], fixture.projectDir)

    const paused = await readTask(fixture.projectDir, externalTaskId)
    expect(paused.state).toBe('feedback')
    expect(paused.currentStepId).toBe('__pipe_feedback__')
    const pausedCtx = JSON.parse(paused.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    expect(pausedCtx.human_feedback).toBeUndefined()

    await queueTaskWithContext(fixture.projectDir, externalTaskId, {
      ...pausedCtx,
      human_feedback: 'approved-by-local-e2e',
    })

    await execCli(['run', '--task', externalTaskId], fixture.projectDir)

    const doneTask = await readTask(fixture.projectDir, externalTaskId)
    expect(doneTask.state).toBe('done')
    const doneCtx = JSON.parse(doneTask.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    expect(doneCtx.approved).toBe(true)
    expect(doneCtx.feedback_value).toBe('approved-by-local-e2e')
    expect(doneCtx.human_feedback).toBeUndefined()
    const traces = await readTaskRunTraces(fixture.projectDir, externalTaskId)
    const traceTypes = new Set(traces.map(trace => trace.type))
    expect(traceTypes.has('started')).toBe(true)
    expect(traceTypes.has('await_feedback')).toBe(true)
    expect(traceTypes.has('resumed')).toBe(true)
    expect(traceTypes.has('completed')).toBe(true)

    const after = await snapshotGlobalNotionflowWrites()
    assertNoNewGlobalNotionflowWrites(before, after)
  })

  it('runs direct definePipe factories and resumes feedback in local mode', async () => {
    const before = await snapshotGlobalNotionflowWrites()
    fixture = await createTempProjectFixture()

    await execCli(['init'], fixture.projectDir)

    const factoryPath = path.join(
      fixture.projectDir,
      'factories',
      'pipe-resume.ts',
    )
    const canonicalModuleUrl = pathToFileURL(
      path.resolve(process.cwd(), 'src/factory/canonical.ts'),
    ).href
    await writeFile(
      factoryPath,
      directPipeFeedbackFactorySource(canonicalModuleUrl),
      'utf8',
    )
    await writeFile(
      path.join(fixture.projectDir, 'notionflow.config.ts'),
      configSource('./factories/pipe-resume.ts'),
      'utf8',
    )

    const externalTaskId = `task-${crypto.randomUUID()}`
    await insertQueuedTask(fixture.projectDir, externalTaskId, 'pipe-resume')

    await execCli(['run', '--task', externalTaskId], fixture.projectDir)

    const paused = await readTask(fixture.projectDir, externalTaskId)
    expect(paused.state).toBe('feedback')
    expect(paused.currentStepId).toBe('__pipe_feedback__')
    const pausedCtx = JSON.parse(paused.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    expect(pausedCtx.attempts).toBe(1)
    expect(pausedCtx.__nf_feedback_prompt).toBe('Approve this task to continue.')

    await queueTaskWithContext(fixture.projectDir, externalTaskId, {
      ...pausedCtx,
      human_feedback: 'approved-by-direct-pipe',
    })

    await execCli(['run', '--task', externalTaskId], fixture.projectDir)

    const doneTask = await readTask(fixture.projectDir, externalTaskId)
    expect(doneTask.state).toBe('done')
    const doneCtx = JSON.parse(doneTask.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    expect(doneCtx.approved).toBe(true)
    expect(doneCtx.feedback_value).toBe('approved-by-direct-pipe')
    expect(doneCtx.attempts).toBe(2)
    expect(doneCtx.human_feedback).toBeUndefined()
    const traces = await readTaskRunTraces(fixture.projectDir, externalTaskId)
    const traceTypes = new Set(traces.map(trace => trace.type))
    expect(traceTypes.has('started')).toBe(true)
    expect(traceTypes.has('await_feedback')).toBe(true)
    expect(traceTypes.has('resumed')).toBe(true)
    expect(traceTypes.has('completed')).toBe(true)

    const after = await snapshotGlobalNotionflowWrites()
    assertNoNewGlobalNotionflowWrites(before, after)
  })

  it('does not expose the removed factory install command', async () => {
    fixture = await createTempProjectFixture()
    const result = await execCliResult(
      ['factory', 'install', '--path', './fake.ts'],
      fixture.projectDir,
    )
    expect(result.code).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`.toLowerCase()).toContain(
      'unknown command',
    )
  })
})

async function execCli(args: string[], cwd: string): Promise<void> {
  const result = await execCliResult(args, cwd)
  if (result.code === 0) {
    return
  }

  throw new Error(
    `Command failed (${result.code ?? -1}): notionflow ${args.join(' ')}\n${result.stderr}`,
  )
}

async function execCliResult(
  args: string[],
  cwd: string,
): Promise<{code: number | null; stdout: string; stderr: string}> {
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
      resolve({code, stdout, stderr})
    })
  })
}

async function insertQueuedTask(
  projectRoot: string,
  externalTaskId: string,
  workflowId: string,
): Promise<void> {
  const {db} = await openApp({projectRoot})
  const timestamp = nowIso()

  await db
    .insert(boards)
    .values({
      id: 'local-board',
      adapter: 'local',
      externalId: 'local-board',
      configJson: '{}',
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoNothing()

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

  await db.insert(tasks).values({
    id: crypto.randomUUID(),
    boardId: 'local-board',
    externalTaskId,
    workflowId,
    state: 'queued',
    currentStepId: null,
    stepVarsJson: null,
    waitingSince: null,
    lockToken: null,
    lockExpiresAt: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
}

async function readTaskState(
  projectRoot: string,
  externalTaskId: string,
): Promise<string> {
  const task = await readTask(projectRoot, externalTaskId)
  return task.state
}

async function readTask(
  projectRoot: string,
  externalTaskId: string,
): Promise<typeof tasks.$inferSelect> {
  const {db} = await openApp({projectRoot})
  const [task] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.externalTaskId, externalTaskId))
  if (!task) {
    throw new Error(`Task not found: ${externalTaskId}`)
  }

  return task
}

async function readTaskRunTraces(
  projectRoot: string,
  externalTaskId: string,
): Promise<Array<typeof runTraces.$inferSelect>> {
  const {db} = await openApp({projectRoot})
  const task = await readTask(projectRoot, externalTaskId)
  return db
    .select()
    .from(runTraces)
    .where(eq(runTraces.taskId, task.id))
}

async function queueTaskWithContext(
  projectRoot: string,
  externalTaskId: string,
  context: Record<string, unknown>,
): Promise<void> {
  const {db} = await openApp({projectRoot})
  await db
    .update(tasks)
    .set({
      state: 'queued',
      stepVarsJson: JSON.stringify(context),
      waitingSince: null,
      updatedAt: nowIso(),
    })
    .where(eq(tasks.externalTaskId, externalTaskId))
}

async function resetTaskToQueued(
  projectRoot: string,
  externalTaskId: string,
): Promise<void> {
  const {db} = await openApp({projectRoot})
  await db
    .update(tasks)
    .set({
      state: 'queued',
      currentStepId: null,
      stepVarsJson: null,
      lockToken: null,
      lockExpiresAt: null,
      lastError: null,
      waitingSince: null,
      updatedAt: nowIso(),
    })
    .where(eq(tasks.externalTaskId, externalTaskId))
}

function factorySource(
  canonicalModuleUrl: string,
  resultState: 'done' | 'failed',
): string {
  return [
    `import {definePipe} from ${JSON.stringify(canonicalModuleUrl)};`,
    '',
    'export default definePipe({',
    '  id: "smoke",',
    '  initial: {},',
    '  run: async ({ ctx }) => ({',
    '    type: "end",',
    `    status: ${JSON.stringify(resultState)},`,
    '    ctx,',
    `    message: ${JSON.stringify(`forced ${resultState}`)},`,
    '  }),',
    '})',
    '',
  ].join('\n')
}

function askResumeFactorySource(canonicalModuleUrl: string): string {
  return [
    `import {ask, definePipe, end, flow} from ${JSON.stringify(canonicalModuleUrl)};`,
    '',
    'const pipe = definePipe({',
    '  id: "ask-resume",',
    '  initial: { approved: false },',
    '  run: flow(',
    '    ask(',
    '      "Please provide feedback to continue.",',
    '      async (ctx, reply) => ({ ...ctx, approved: true, feedback_value: reply }),',
    '    ),',
    '    end.done(),',
    '  ),',
    '})',
    '',
    'export default pipe;',
    '',
  ].join('\n')
}

function directPipeFeedbackFactorySource(canonicalModuleUrl: string): string {
  return [
    `import {ask, definePipe, end, flow, step} from ${JSON.stringify(canonicalModuleUrl)};`,
    '',
    'const pipe = definePipe({',
    '  id: "pipe-resume",',
    '  initial: { approved: false, attempts: 0 },',
    '  run: flow(',
    '    step("count", ctx => ({ ...ctx, attempts: Number(ctx.attempts ?? 0) + 1 })),',
    '    ask(',
    '      "Approve this task to continue.",',
    '      async (ctx, reply) => ({ ...ctx, approved: true, feedback_value: reply }),',
    '    ),',
    '    step("persist", ctx => ctx),',
    '    end.done(),',
    '  ),',
    '});',
    '',
    'export default pipe;',
    '',
  ].join('\n')
}

function configSource(factoryPath: string): string {
  return [
    'export default {',
    `  factories: [${JSON.stringify(factoryPath)}],`,
    '};',
    '',
  ].join('\n')
}
