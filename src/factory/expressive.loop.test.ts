import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {eq} from 'drizzle-orm'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {compileExpressiveFactory, loop} from './expressive'

const homes: string[] = []
const originalHome = process.env.HOME
const originalProjectRoot = process.env.NOTIONFLOW_PROJECT_ROOT

async function setupRuntime() {
  const home = await mkdtemp(path.join(tmpdir(), 'notionflow-expressive-loop-test-'))
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

describe('expressive loop compilation', () => {
  afterEach(async () => {
    process.env.HOME = originalHome
    process.env.NOTIONFLOW_PROJECT_ROOT = originalProjectRoot
    for (const home of homes.splice(0, homes.length)) {
      await rm(home, {recursive: true, force: true})
    }
  })

  it('compiles loop primitives into runtime loop states with continue/done/exhausted routing', () => {
    const compiled = compileExpressiveFactory({
      id: 'compiled-loop-shape-factory',
      start: 'plan_loop',
      context: {round: 0},
      guards: {
        planReady: (input: any) =>
          Boolean((input.ctx as Record<string, unknown>).ready) ||
          Number(input.iteration ?? 0) >= 2,
      },
      states: {
        plan_loop: loop({
          body: 'draft_plan',
          maxIterations: 3,
          until: 'planReady',
          on: {
            continue: 'unexpected-target',
            done: 'done',
            exhausted: 'failed',
          },
        }),
        draft_plan: {
          type: 'action',
          agent: async ({ctx}: any) => ({
            status: 'done',
            data: {round: Number(ctx.round ?? 0) + 1},
          }),
          on: {
            done: 'plan_loop',
            failed: 'failed',
          },
        },
        done: {type: 'done'},
        failed: {type: 'failed'},
      },
    })

    const planLoopState = compiled.states.plan_loop
    if (!planLoopState || planLoopState.type !== 'loop') {
      throw new Error('Expected compiled loop state for `plan_loop`')
    }

    expect(planLoopState.body).toBe('draft_plan')
    expect(planLoopState.maxIterations).toBe(3)
    expect(planLoopState.until).toBe('planReady')
    expect(planLoopState.on.continue).toBe('draft_plan')
    expect(planLoopState.on.done).toBe('done')
    expect(planLoopState.on.exhausted).toBe('failed')
  })

  it('supports function-based loop completion guards', async () => {
    const untilGuard = vi.fn((input: any) => Number(input.iteration ?? 0) >= 1)

    const compiled = compileExpressiveFactory({
      id: 'compiled-loop-until-fn-factory',
      start: 'review_loop',
      context: {},
      states: {
        review_loop: loop({
          body: 'draft_review',
          maxIterations: 2,
          until: untilGuard,
          on: {
            continue: 'draft_review',
            done: 'done',
            exhausted: 'failed',
          },
        }),
        draft_review: {
          type: 'action',
          agent: async () => ({status: 'done'}),
          on: {
            done: 'review_loop',
            failed: 'failed',
          },
        },
        done: {type: 'done'},
        failed: {type: 'failed'},
      },
    })

    const reviewLoopState = compiled.states.review_loop
    if (!reviewLoopState || reviewLoopState.type !== 'loop') {
      throw new Error('Expected compiled loop state for `review_loop`')
    }
    if (typeof reviewLoopState.until !== 'function') {
      throw new Error('Expected function-based `until` guard on compiled loop state')
    }

    const until = reviewLoopState.until as (input: {
      ctx: Record<string, unknown>
      iteration: number
    }) => boolean | Promise<boolean>

    const isDone = await until({ctx: {}, iteration: 1})
    expect(isDone).toBe(true)
    expect(untilGuard).toHaveBeenCalledWith({ctx: {}, iteration: 1})
  })

  it('requires positive maxIterations for compiled loop states', () => {
    expect(() =>
      compileExpressiveFactory({
        id: 'compiled-loop-bounded-iterations-factory',
        start: 'plan_loop',
        context: {},
        states: {
          plan_loop: loop({
            body: 'draft_plan',
            maxIterations: 0,
            on: {
              continue: 'draft_plan',
              done: 'done',
              exhausted: 'failed',
            },
          }),
          draft_plan: {type: 'done'},
          done: {type: 'done'},
          failed: {type: 'failed'},
        },
      }),
    ).toThrow()
  })

  it('executes compiled loop workflows until guard-based completion', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'compiled-loop-runtime-done-factory'
    const externalTaskId = 'task-compiled-loop-runtime-done-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)
    const expressiveModuleUrl = pathToFileURL(
      path.resolve('src/factory/expressive.ts'),
    ).href

    await writeFile(
      factoryPath,
      `import {compileExpressiveFactory, loop, step} from "${expressiveModuleUrl}";\n` +
        `const compiled = compileExpressiveFactory({\n` +
        `  id: "${factoryId}",\n` +
        `  start: "loop_gate",\n` +
        `  context: { iterations: 0 },\n` +
        `  guards: {\n` +
        `    loopDone: ({ ctx }) => Number(ctx.iterations ?? 0) >= 2\n` +
        `  },\n` +
        `  states: {\n` +
        `    loop_gate: loop({\n` +
        `      body: "work",\n` +
        `      maxIterations: 5,\n` +
        `      until: "loopDone",\n` +
        `      on: { continue: "unexpected", done: "done", exhausted: "failed" }\n` +
        `    }),\n` +
        `    work: step({\n` +
        `      run: async ({ ctx }) => ({\n` +
        `        status: "done",\n` +
        `        data: { iterations: Number(ctx.iterations ?? 0) + 1 }\n` +
        `      }),\n` +
        `      on: { done: "loop_gate", failed: "failed" }\n` +
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
    expect(doneCtx.iterations).toBe(2)

    const events = await db
      .select()
      .from(schema.transitionEvents)
      .where(eq(schema.transitionEvents.taskId, updatedTask!.id))
    expect(
      events.map(
        event =>
          `${event.fromStateId}->${event.toStateId}:${event.reason}:${event.event}`,
      ),
    ).toEqual([
      'loop_gate->work:loop.continue:continue',
      'work->loop_gate:action.done:done',
      'loop_gate->work:loop.continue:continue',
      'work->loop_gate:action.done:done',
      'loop_gate->done:loop.done:done',
    ])
    expect(
      events
        .filter(event => event.fromStateId === 'loop_gate')
        .map(event => event.loopIteration),
    ).toEqual([1, 2, 2])
  })

  it('routes compiled loops to exhausted when max iterations are reached', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'compiled-loop-runtime-exhausted-factory'
    const externalTaskId = 'task-compiled-loop-runtime-exhausted-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)
    const expressiveModuleUrl = pathToFileURL(
      path.resolve('src/factory/expressive.ts'),
    ).href

    await writeFile(
      factoryPath,
      `import {compileExpressiveFactory, loop, step} from "${expressiveModuleUrl}";\n` +
        `const compiled = compileExpressiveFactory({\n` +
        `  id: "${factoryId}",\n` +
        `  start: "loop_gate",\n` +
        `  context: { iterations: 0 },\n` +
        `  guards: {\n` +
        `    neverDone: () => false\n` +
        `  },\n` +
        `  states: {\n` +
        `    loop_gate: loop({\n` +
        `      body: "work",\n` +
        `      maxIterations: 2,\n` +
        `      until: "neverDone",\n` +
        `      on: { continue: "work", done: "done", exhausted: "failed" }\n` +
        `    }),\n` +
        `    work: step({\n` +
        `      run: async ({ ctx }) => ({\n` +
        `        status: "done",\n` +
        `        data: { iterations: Number(ctx.iterations ?? 0) + 1 }\n` +
        `      }),\n` +
        `      on: { done: "loop_gate", failed: "failed" }\n` +
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
    const finalCtx = JSON.parse(updatedTask?.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    expect(finalCtx.iterations).toBe(2)

    const events = await db
      .select()
      .from(schema.transitionEvents)
      .where(eq(schema.transitionEvents.taskId, updatedTask!.id))
    expect(
      events.map(
        event =>
          `${event.fromStateId}->${event.toStateId}:${event.reason}:${event.event}`,
      ),
    ).toEqual([
      'loop_gate->work:loop.continue:continue',
      'work->loop_gate:action.done:done',
      'loop_gate->work:loop.continue:continue',
      'work->loop_gate:action.done:done',
      'loop_gate->failed:loop.exhausted:exhausted',
    ])
    const exhausted = events.find(event => event.reason === 'loop.exhausted')
    expect(exhausted?.loopIteration).toBe(2)
  })
})
