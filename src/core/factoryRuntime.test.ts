import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {eq} from 'drizzle-orm'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {replayRunTraces} from './runTraces'

const homes: string[] = []
const originalHome = process.env.HOME
const originalProjectRoot = process.env.NOTIONFLOW_PROJECT_ROOT

async function setupRuntime() {
  const home = await mkdtemp(path.join(tmpdir(), 'notionflow-runtime-test-'))
  homes.push(home)
  process.env.HOME = home
  process.env.NOTIONFLOW_PROJECT_ROOT = home
  await writeFile(
    path.join(home, 'notionflow.config.ts'),
    'export default { factories: [] };\n',
    'utf8',
  )
  vi.resetModules()

  const [{nowIso, openApp}, {paths}, runtime, schema] = await Promise.all([
    import('../app/context'),
    import('../config/paths'),
    import('./factoryRuntime'),
    import('../db/schema'),
  ])

  const {db} = await openApp()
  const timestamp = nowIso()
  return {db, paths, runtime, schema, timestamp}
}

async function insertQueuedTask(input: {
  db: Awaited<ReturnType<typeof setupRuntime>>['db']
  schema: Awaited<ReturnType<typeof setupRuntime>>['schema']
  timestamp: string
  factoryId: string
  externalTaskId: string
}): Promise<void> {
  await input.db.insert(input.schema.boards).values({
    id: input.factoryId,
    adapter: 'local',
    externalId: 'local-board',
    configJson: '{}',
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  })

  await input.db.insert(input.schema.workflows).values({
    id: input.factoryId,
    version: 1,
    definitionYaml: '{}',
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  })

  await input.db.insert(input.schema.tasks).values({
    id: crypto.randomUUID(),
    boardId: input.factoryId,
    externalTaskId: input.externalTaskId,
    workflowId: input.factoryId,
    state: 'queued',
    currentStepId: null,
    stepVarsJson: null,
    waitingSince: null,
    lockToken: null,
    lockExpiresAt: null,
    lastError: null,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  })
}

function transitionLike<T extends {type: string | null}>(traces: T[]): T[] {
  return traces.filter(trace => trace.type === 'step' || trace.type === 'retry')
}

describe('factoryRuntime (definePipe only)', () => {
  afterEach(async () => {
    process.env.HOME = originalHome
    process.env.NOTIONFLOW_PROJECT_ROOT = originalProjectRoot
    for (const home of homes.splice(0, homes.length)) {
      await rm(home, {recursive: true, force: true})
    }
  })

  it('executes direct pipe factories and persists task/run state', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'runtime-direct-pipe-factory'
    const externalTaskId = 'task-direct-pipe-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)

    await writeFile(
      factoryPath,
      `export default {\n` +
        `  id: "${factoryId}",\n` +
        `  initial: { visits: 0 },\n` +
        `  run: async ({ ctx, writePage }) => {\n` +
        `    await writePage({ markdown: "# Pipe Output" });\n` +
        `    return { ...ctx, visits: Number(ctx.visits ?? 0) + 1, finishedBy: "pipe" };\n` +
        `  },\n` +
        `};\n`,
      'utf8',
    )

    await insertQueuedTask({db, schema, timestamp, factoryId, externalTaskId})
    await runtime.runFactoryTaskByExternalId(externalTaskId)

    const [updatedTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(updatedTask?.state).toBe('done')
    expect(updatedTask?.currentStepId).toBeNull()

    const persistedCtx = JSON.parse(updatedTask?.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    expect(persistedCtx.visits).toBe(1)
    expect(persistedCtx.finishedBy).toBe('pipe')

    const [run] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, updatedTask!.id))
    expect(run?.status).toBe('done')
    expect(run?.currentStateId).toBeNull()
    expect(run?.endedAt).toBeTruthy()

    const traces = await db
      .select()
      .from(schema.runTraces)
      .where(eq(schema.runTraces.taskId, updatedTask!.id))
    const events = transitionLike(traces)
    expect(events).toHaveLength(1)
    expect(events[0]?.fromStateId).toBe('__pipe_run__')
    expect(events[0]?.toStateId).toBe('__pipe_done__')
    expect(replayRunTraces(events)).toBe('__pipe_done__')

    const traceTypes = new Set(traces.map(trace => trace.type))
    expect(traceTypes.has('started')).toBe(true)
    expect(traceTypes.has('write')).toBe(true)
    expect(traceTypes.has('completed')).toBe(true)
  })

  it('persists direct pipe feedback state and resumes from persisted context', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'runtime-direct-pipe-feedback'
    const externalTaskId = 'task-direct-pipe-feedback-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)

    await writeFile(
      factoryPath,
      `export default {\n` +
        `  id: "${factoryId}",\n` +
        `  initial: { attempts: 0, approved: false },\n` +
        `  run: async ({ ctx }) => {\n` +
        `    const attempts = Number(ctx.attempts ?? 0) + 1;\n` +
        `    if (!ctx.human_feedback) {\n` +
        `      return {\n` +
        `        type: "await_feedback",\n` +
        `        prompt: "Please approve",\n` +
        `        ctx: { ...ctx, attempts },\n` +
        `      };\n` +
        `    }\n` +
        `    const { human_feedback: _ignored, ...rest } = ctx;\n` +
        `    return {\n` +
        `      type: "end",\n` +
        `      status: "done",\n` +
        `      ctx: { ...rest, attempts, approved: true },\n` +
        `    };\n` +
        `  },\n` +
        `};\n`,
      'utf8',
    )

    await insertQueuedTask({db, schema, timestamp, factoryId, externalTaskId})
    await runtime.runFactoryTaskByExternalId(externalTaskId)

    const [paused] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(paused?.state).toBe('feedback')
    expect(paused?.currentStepId).toBe('__pipe_feedback__')
    const pausedCtx = JSON.parse(paused?.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    expect(pausedCtx.attempts).toBe(1)
    expect(pausedCtx.__nf_feedback_prompt).toBe('Please approve')

    await db
      .update(schema.tasks)
      .set({
        state: 'queued',
        stepVarsJson: JSON.stringify({
          ...pausedCtx,
          human_feedback: 'approved',
        }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.tasks.externalTaskId, externalTaskId))

    await runtime.runFactoryTaskByExternalId(externalTaskId)

    const [doneTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(doneTask?.state).toBe('done')
    const doneCtx = JSON.parse(doneTask?.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    expect(doneCtx.attempts).toBe(2)
    expect(doneCtx.approved).toBe(true)
    expect(doneCtx.human_feedback).toBeUndefined()

    const traces = await db
      .select()
      .from(schema.runTraces)
      .where(eq(schema.runTraces.taskId, doneTask!.id))
    const events = transitionLike(traces)
    expect(
      events.map(event => `${event.fromStateId}->${event.toStateId}:${event.event}`),
    ).toEqual([
      '__pipe_run__->__pipe_feedback__:feedback',
      '__pipe_feedback__->__pipe_done__:done',
    ])

    const traceTypes = new Set(traces.map(trace => trace.type))
    expect(traceTypes.has('await_feedback')).toBe(true)
    expect(traceTypes.has('resumed')).toBe(true)
  })

  it('maps terminal end signals to persisted task and run statuses', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const terminalStates = ['done', 'blocked', 'failed'] as const

    for (const terminalState of terminalStates) {
      const factoryId = `runtime-terminal-${terminalState}`
      const externalTaskId = `task-terminal-${terminalState}`
      const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)

      await writeFile(
        factoryPath,
        `export default {\n` +
          `  id: "${factoryId}",\n` +
          `  initial: {},\n` +
          `  run: async ({ ctx }) => ({ type: "end", status: "${terminalState}", ctx, message: "terminal ${terminalState}" }),\n` +
          `};\n`,
        'utf8',
      )

      await insertQueuedTask({db, schema, timestamp, factoryId, externalTaskId})
      await runtime.runFactoryTaskByExternalId(externalTaskId)

      const [updatedTask] = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.externalTaskId, externalTaskId))
      expect(updatedTask).toBeTruthy()
      expect(updatedTask?.state).toBe(terminalState)

      const [run] = await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.taskId, updatedTask!.id))
      expect(run?.status).toBe(terminalState)
      expect(run?.currentStateId).toBeNull()
      expect(run?.endedAt).toBeTruthy()
    }
  })

  it('fails run when pipe returns non-object context', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'runtime-invalid-pipe-context'
    const externalTaskId = 'task-invalid-pipe-context-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)

    await writeFile(
      factoryPath,
      `export default {\n` +
        `  id: "${factoryId}",\n` +
        `  initial: {},\n` +
        `  run: async () => "invalid-context",\n` +
        `};\n`,
      'utf8',
    )

    await insertQueuedTask({db, schema, timestamp, factoryId, externalTaskId})
    await expect(
      runtime.runFactoryTaskByExternalId(externalTaskId),
    ).rejects.toThrow(/Pipe execution failed/)

    const [updatedTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(updatedTask?.state).toBe('failed')
    expect(updatedTask?.lastError).toContain('Pipe execution failed')

    const traces = await db
      .select()
      .from(schema.runTraces)
      .where(eq(schema.runTraces.taskId, updatedTask!.id))
    const traceTypes = traces.map(trace => trace.type)
    expect(traceTypes).toContain('error')
    expect(traceTypes).toContain('completed')
  })
})
