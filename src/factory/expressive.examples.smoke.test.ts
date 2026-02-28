import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {eq} from 'drizzle-orm'
import {afterEach, describe, expect, it, vi} from 'vitest'
import expressivePrimitivesFactory from '../../example-factories/factories/expressive-primitives'

const homes: string[] = []
const originalHome = process.env.HOME
const originalProjectRoot = process.env.NOTIONFLOW_PROJECT_ROOT

async function setupRuntime() {
  const home = await mkdtemp(path.join(tmpdir(), 'notionflow-expressive-example-test-'))
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
    import('../core/factoryRuntime'),
    import('../db/schema'),
  ])

  const {db} = await openApp()
  const timestamp = nowIso()
  return {db, paths, runtime, schema, timestamp}
}

type RuntimeSetup = Awaited<ReturnType<typeof setupRuntime>>
type RuntimeDb = RuntimeSetup['db']
type RuntimeSchema = RuntimeSetup['schema']

async function writeExampleFactoryModule(
  workflowsDir: string,
  factoryId: string,
): Promise<void> {
  const factoryPath = path.join(workflowsDir, `${factoryId}.mjs`)
  const exampleModuleUrl = pathToFileURL(
    path.resolve('example-factories/factories/expressive-primitives.ts'),
  ).href

  await writeFile(
    factoryPath,
    `import factory from "${exampleModuleUrl}";\nexport default factory;\n`,
    'utf8',
  )
}

async function seedFactoryRecords(
  db: RuntimeDb,
  schema: RuntimeSchema,
  factoryId: string,
  timestamp: string,
) {
  await db.insert(schema.boards).values({
    id: factoryId,
    adapter: 'local',
    externalId: 'local-board',
    configJson: '{}',
    createdAt: timestamp,
    updatedAt: timestamp,
  })

  await db.insert(schema.workflows).values({
    id: factoryId,
    version: 1,
    definitionYaml: '{}',
    createdAt: timestamp,
    updatedAt: timestamp,
  })
}

async function insertQueuedTask(
  db: RuntimeDb,
  schema: RuntimeSchema,
  factoryId: string,
  externalTaskId: string,
  timestamp: string,
) {
  await db.insert(schema.tasks).values({
    id: crypto.randomUUID(),
    boardId: factoryId,
    externalTaskId,
    workflowId: factoryId,
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

async function queueFeedback(
  db: RuntimeDb,
  schema: RuntimeSchema,
  externalTaskId: string,
  feedback: string,
) {
  const [task] = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.externalTaskId, externalTaskId))

  const ctx = JSON.parse(task?.stepVarsJson ?? '{}') as Record<string, unknown>
  await db
    .update(schema.tasks)
    .set({
      state: 'queued',
      stepVarsJson: JSON.stringify({...ctx, human_feedback: feedback}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.tasks.externalTaskId, externalTaskId))
}

describe('expressive primitive example smoke tests', () => {
  afterEach(async () => {
    process.env.HOME = originalHome
    process.env.NOTIONFLOW_PROJECT_ROOT = originalProjectRoot
    for (const home of homes.splice(0, homes.length)) {
      await rm(home, {recursive: true, force: true})
    }
  })

  it('includes all expressive primitives in a runnable example factory', () => {
    expect(expressivePrimitivesFactory.id).toBe('expressive-primitives')
    expect(expressivePrimitivesFactory.states.start_draft?.type).toBe('action')
    expect(expressivePrimitivesFactory.states.collect_decision?.type).toBe('action')
    expect(expressivePrimitivesFactory.states.collect_decision__feedback?.type).toBe(
      'feedback',
    )
    expect(expressivePrimitivesFactory.states.decision_route?.type).toBe(
      'orchestrate',
    )
    expect(expressivePrimitivesFactory.states.revision_loop?.type).toBe('loop')

    const applyRevision = expressivePrimitivesFactory.states.apply_revision
    if (!applyRevision || applyRevision.type !== 'action') {
      throw new Error('Expected apply_revision to compile as an action state')
    }
    expect(applyRevision.retries).toEqual({
      max: 1,
      backoff: {strategy: 'fixed', ms: 0},
    })

    expect(expressivePrimitivesFactory.states.publish_result?.type).toBe('action')
    expect(expressivePrimitivesFactory.states.done?.type).toBe('done')
    expect(expressivePrimitivesFactory.states.failed?.type).toBe('failed')
  })

  it('runs the approve branch end-to-end through runtime execution', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = expressivePrimitivesFactory.id
    const externalTaskId = 'task-expressive-primitives-approve-1'

    await writeExampleFactoryModule(paths.workflowsDir, factoryId)
    await seedFactoryRecords(db, schema, factoryId, timestamp)
    await insertQueuedTask(db, schema, factoryId, externalTaskId, timestamp)

    await runtime.runFactoryTaskByExternalId(externalTaskId)

    const [paused] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(paused?.state).toBe('feedback')
    expect(paused?.currentStepId).toBe('collect_decision')

    await queueFeedback(db, schema, externalTaskId, 'approve')

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
    expect(doneCtx.decision).toBe('approve')
    expect(doneCtx.draft_ready).toBe(true)
    expect(doneCtx.revisions).toBe(0)
    expect(doneCtx.retry_attempts).toBe(0)

    const events = await db
      .select()
      .from(schema.transitionEvents)
      .where(eq(schema.transitionEvents.taskId, doneTask!.id))

    expect(
      events.map(
        event => `${event.fromStateId}->${event.toStateId}:${event.reason}:${event.event}`,
      ),
    ).toEqual([
      'start_draft->collect_decision:action.done:done',
      'collect_decision->collect_decision__feedback:action.feedback:feedback',
      'collect_decision->decision_route:action.done:done',
      'decision_route->publish_result:orchestrate.select:publish',
      'publish_result->done:action.done:done',
    ])
  })

  it('runs revise branch with retry and loop semantics through runtime execution', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = expressivePrimitivesFactory.id
    const externalTaskId = 'task-expressive-primitives-revise-1'

    await writeExampleFactoryModule(paths.workflowsDir, factoryId)
    await seedFactoryRecords(db, schema, factoryId, timestamp)
    await insertQueuedTask(db, schema, factoryId, externalTaskId, timestamp)

    await runtime.runFactoryTaskByExternalId(externalTaskId)
    await queueFeedback(db, schema, externalTaskId, 'revise')

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
    expect(doneCtx.decision).toBe('revise')
    expect(doneCtx.revisions).toBe(1)
    expect(doneCtx.retry_attempts).toBe(2)
    expect(doneCtx.draft_ready).toBe(true)

    const events = await db
      .select()
      .from(schema.transitionEvents)
      .where(eq(schema.transitionEvents.taskId, doneTask!.id))

    expect(
      events.map(
        event => `${event.fromStateId}->${event.toStateId}:${event.reason}:${event.event}`,
      ),
    ).toEqual([
      'start_draft->collect_decision:action.done:done',
      'collect_decision->collect_decision__feedback:action.feedback:feedback',
      'collect_decision->decision_route:action.done:done',
      'decision_route->revision_loop:orchestrate.select:revise',
      'revision_loop->apply_revision:loop.continue:continue',
      'apply_revision->apply_revision:action.attempt.failed:failed',
      'apply_revision->revision_loop:action.done:done',
      'revision_loop->publish_result:loop.done:done',
      'publish_result->done:action.done:done',
    ])

    const retryTransition = events.find(
      event =>
        event.fromStateId === 'apply_revision' &&
        event.toStateId === 'apply_revision' &&
        event.reason === 'action.attempt.failed',
    )
    expect(retryTransition?.attempt).toBe(1)
  })
})
