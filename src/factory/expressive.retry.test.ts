import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {eq} from 'drizzle-orm'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {compileExpressiveFactory, retry, step} from './expressive'

const homes: string[] = []
const originalHome = process.env.HOME
const originalProjectRoot = process.env.NOTIONFLOW_PROJECT_ROOT

async function setupRuntime() {
  const home = await mkdtemp(path.join(tmpdir(), 'notionflow-expressive-retry-test-'))
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

describe('expressive retry compilation', () => {
  afterEach(async () => {
    process.env.HOME = originalHome
    process.env.NOTIONFLOW_PROJECT_ROOT = originalProjectRoot
    for (const home of homes.splice(0, homes.length)) {
      await rm(home, {recursive: true, force: true})
    }
  })

  it('compiles retry primitive nodes into action retry config', () => {
    const compiled = compileExpressiveFactory({
      id: 'compiled-retry-shape-factory',
      start: 'work',
      context: {attempts: 0},
      states: {
        work: step({
          run: async ({ctx}) => ({
            status: 'done',
            data: {attempts: Number(ctx.attempts ?? 0) + 1},
          }),
          retries: retry({
            max: 2,
            backoff: {strategy: 'fixed', ms: 25},
          }),
          on: {
            done: 'done',
            failed: 'failed',
          },
        }),
        done: {type: 'done'},
        failed: {type: 'failed'},
      },
    })

    const workState = compiled.states.work
    if (!workState || workState.type !== 'action') {
      throw new Error('Expected compiled action state for `work`')
    }

    expect(workState.retries).toEqual({
      max: 2,
      backoff: {strategy: 'fixed', ms: 25},
    })
  })

  it('supports exponential backoff with optional cap in compiled retry config', () => {
    const compiled = compileExpressiveFactory({
      id: 'compiled-retry-exponential-shape-factory',
      start: 'work',
      context: {},
      states: {
        work: step({
          run: async () => ({status: 'done'}),
          retries: retry({
            max: 3,
            backoff: {strategy: 'exponential', ms: 100, maxMs: 1000},
          }),
          on: {
            done: 'done',
            failed: 'failed',
          },
        }),
        done: {type: 'done'},
        failed: {type: 'failed'},
      },
    })

    const workState = compiled.states.work
    if (!workState || workState.type !== 'action') {
      throw new Error('Expected compiled action state for `work`')
    }

    expect(workState.retries).toEqual({
      max: 3,
      backoff: {strategy: 'exponential', ms: 100, maxMs: 1000},
    })
  })

  it('persists retry attempt progression and succeeds before exhaustion', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'compiled-retry-runtime-success-factory'
    const externalTaskId = 'task-compiled-retry-runtime-success-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)
    const expressiveModuleUrl = pathToFileURL(
      path.resolve('src/factory/expressive.ts'),
    ).href

    await writeFile(
      factoryPath,
      `import {compileExpressiveFactory, retry, step} from "${expressiveModuleUrl}";\n` +
        `const compiled = compileExpressiveFactory({\n` +
        `  id: "${factoryId}",\n` +
        `  start: "work",\n` +
        `  context: { attempts: 0 },\n` +
        `  states: {\n` +
        `    work: step({\n` +
        `      run: async ({ ctx }) => {\n` +
        `        const attempts = Number(ctx.attempts ?? 0) + 1;\n` +
        `        if (attempts < 3) {\n` +
        `          return { status: "failed", message: "transient", data: { attempts } };\n` +
        `        }\n` +
        `        return { status: "done", data: { attempts } };\n` +
        `      },\n` +
        `      retries: retry({ max: 2, backoff: { strategy: "fixed", ms: 0 } }),\n` +
        `      on: { done: "done", failed: "failed" }\n` +
        `    }),\n` +
        `    done: { type: "done" },\n` +
        `    failed: { type: "failed" }\n` +
        `  }\n` +
        `});\n` +
        `export default compiled.factory;\n`,
      'utf8',
    )

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

    await runtime.runFactoryTaskByExternalId(externalTaskId)

    const [updatedTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(updatedTask?.state).toBe('done')
    const doneCtx = JSON.parse(updatedTask?.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    expect(doneCtx.attempts).toBe(3)

    const events = await db
      .select()
      .from(schema.transitionEvents)
      .where(eq(schema.transitionEvents.taskId, updatedTask!.id))
    expect(
      events.map(
        event =>
          `${event.fromStateId}->${event.toStateId}:${event.reason}:${event.attempt}`,
      ),
    ).toEqual([
      'work->work:action.attempt.failed:1',
      'work->work:action.attempt.failed:2',
      'work->done:action.done:3',
    ])
  })

  it('routes retries to failed when attempts are exhausted', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'compiled-retry-runtime-exhausted-factory'
    const externalTaskId = 'task-compiled-retry-runtime-exhausted-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)
    const expressiveModuleUrl = pathToFileURL(
      path.resolve('src/factory/expressive.ts'),
    ).href

    await writeFile(
      factoryPath,
      `import {compileExpressiveFactory, retry, step} from "${expressiveModuleUrl}";\n` +
        `const compiled = compileExpressiveFactory({\n` +
        `  id: "${factoryId}",\n` +
        `  start: "work",\n` +
        `  context: { attempts: 0 },\n` +
        `  states: {\n` +
        `    work: step({\n` +
        `      run: async ({ ctx }) => ({\n` +
        `        status: "failed",\n` +
        `        message: "hard-fail",\n` +
        `        data: { attempts: Number(ctx.attempts ?? 0) + 1 }\n` +
        `      }),\n` +
        `      retries: retry({ max: 1 }),\n` +
        `      on: { done: "done", failed: "failed" }\n` +
        `    }),\n` +
        `    done: { type: "done" },\n` +
        `    failed: { type: "failed" }\n` +
        `  }\n` +
        `});\n` +
        `export default compiled.factory;\n`,
      'utf8',
    )

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

    await runtime.runFactoryTaskByExternalId(externalTaskId)

    const [updatedTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(updatedTask?.state).toBe('failed')
    expect(updatedTask?.lastError).toContain('hard-fail')

    const events = await db
      .select()
      .from(schema.transitionEvents)
      .where(eq(schema.transitionEvents.taskId, updatedTask!.id))
    expect(
      events.map(
        event =>
          `${event.fromStateId}->${event.toStateId}:${event.reason}:${event.attempt}`,
      ),
    ).toEqual([
      'work->work:action.attempt.failed:1',
      'work->failed:action.failed.exhausted:2',
    ])
  })
})
