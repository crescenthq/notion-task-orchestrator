import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {eq} from 'drizzle-orm'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {compileExpressiveFactory, step} from './expressive'

const homes: string[] = []
const originalHome = process.env.HOME
const originalProjectRoot = process.env.NOTIONFLOW_PROJECT_ROOT

async function setupRuntime() {
  const home = await mkdtemp(path.join(tmpdir(), 'notionflow-expressive-step-test-'))
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

describe('expressive step compilation', () => {
  afterEach(async () => {
    process.env.HOME = originalHome
    process.env.NOTIONFLOW_PROJECT_ROOT = originalProjectRoot
    for (const home of homes.splice(0, homes.length)) {
      await rm(home, {recursive: true, force: true})
    }
  })

  it('compiles step primitives into action-state shape with routed transitions', () => {
    const compiled = compileExpressiveFactory({
      id: 'compiled-step-shape-factory',
      start: 'work',
      context: {attempts: 0},
      states: {
        work: step({
          run: async ({ctx}) => ({
            status: 'done',
            data: {attempts: Number(ctx.attempts ?? 0) + 1},
          }),
          retries: {
            max: 2,
            backoff: {strategy: 'fixed', ms: 0},
          },
          on: {
            done: 'done',
            feedback: 'await_human',
            failed: 'failed',
          },
        }),
        done: {type: 'done'},
        await_human: {type: 'blocked'},
        failed: {type: 'failed'},
      },
    })

    const workState = compiled.states.work
    if (!workState || workState.type !== 'action') {
      throw new Error('Expected compiled action state for `work`')
    }

    expect(typeof workState.agent).toBe('function')
    expect(workState.on).toEqual({
      done: 'done',
      feedback: 'await_human',
      failed: 'failed',
    })
    expect(workState.retries).toEqual({
      max: 2,
      backoff: {strategy: 'fixed', ms: 0},
    })
  })

  it('executes compiled step workflows via runFactoryTaskByExternalId and records transitions', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'compiled-step-runtime-factory'
    const externalTaskId = 'task-compiled-step-runtime-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)
    const expressiveModuleUrl = pathToFileURL(
      path.resolve('src/factory/expressive.ts'),
    ).href

    await writeFile(
      factoryPath,
      `import {compileExpressiveFactory, step} from "${expressiveModuleUrl}";\n` +
        `const compiled = compileExpressiveFactory({\n` +
        `  id: "${factoryId}",\n` +
        `  start: "work",\n` +
        `  context: { score: 0 },\n` +
        `  states: {\n` +
        `    work: step({\n` +
        `      run: async ({ ctx }) => ({\n` +
        `        status: "done",\n` +
        `        data: { score: Number(ctx.score ?? 0) + 1 },\n` +
        `        message: "compiled step completed"\n` +
        `      }),\n` +
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
    expect(updatedTask).toBeTruthy()
    expect(updatedTask?.state).toBe('done')
    const doneCtx = JSON.parse(updatedTask?.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    expect(doneCtx.score).toBe(1)

    const events = await db
      .select()
      .from(schema.transitionEvents)
      .where(eq(schema.transitionEvents.taskId, updatedTask!.id))
    expect(events).toHaveLength(1)
    expect(events[0]?.fromStateId).toBe('work')
    expect(events[0]?.toStateId).toBe('done')
    expect(events[0]?.event).toBe('done')
    expect(events[0]?.reason).toBe('action.done')
  })
})
