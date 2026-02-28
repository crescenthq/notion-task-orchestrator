import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {eq} from 'drizzle-orm'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {compileExpressiveFactory, route} from './expressive'

const homes: string[] = []
const originalHome = process.env.HOME
const originalProjectRoot = process.env.NOTIONFLOW_PROJECT_ROOT

async function setupRuntime() {
  const home = await mkdtemp(path.join(tmpdir(), 'notionflow-expressive-route-test-'))
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

describe('expressive route compilation', () => {
  afterEach(async () => {
    process.env.HOME = originalHome
    process.env.NOTIONFLOW_PROJECT_ROOT = originalProjectRoot
    for (const home of homes.splice(0, homes.length)) {
      await rm(home, {recursive: true, force: true})
    }
  })

  it('compiles route primitives into orchestrate states with explicit event mapping', async () => {
    const compiled = compileExpressiveFactory({
      id: 'compiled-route-shape-factory',
      start: 'decide',
      context: {approved: true},
      states: {
        decide: route({
          select: ({ctx}) => (ctx.approved ? 'approve' : 'revise'),
          on: {
            approve: 'done',
            revise: 'revise_plan',
          },
        }),
        revise_plan: {type: 'blocked'},
        done: {type: 'done'},
      },
    })

    const decideState = compiled.states.decide
    if (!decideState || decideState.type !== 'orchestrate') {
      throw new Error('Expected compiled orchestrate state for `decide`')
    }

    expect(typeof decideState.select).toBe('function')
    expect(decideState.on.approve).toBe('done')
    expect(decideState.on.revise).toBe('revise_plan')

    const selectRoute = decideState.select as (
      input: {ctx: Record<string, unknown>},
    ) => string | Promise<string>
    const selectedEvent = await selectRoute({ctx: {approved: true}})
    expect(selectedEvent).toBe('approve')
  })

  it('routes unknown selector events to a deterministic failed terminal path', async () => {
    const compiled = compileExpressiveFactory({
      id: 'compiled-route-fallback-factory',
      start: 'decide',
      context: {},
      states: {
        decide: route({
          select: () => 'unmapped-event',
          on: {
            approve: 'done',
          },
        }),
        done: {type: 'done'},
      },
    })

    const decideState = compiled.states.decide
    if (!decideState || decideState.type !== 'orchestrate' || !decideState.select) {
      throw new Error('Expected compiled orchestrate state with select for `decide`')
    }

    const selectRoute = decideState.select as (
      input: {ctx: Record<string, unknown>},
    ) => string | Promise<string>
    const selectedEvent = await selectRoute({ctx: {}})
    const fallbackTarget = decideState.on[selectedEvent]

    expect(fallbackTarget).toBe('decide__route_failed')
    expect(compiled.states[fallbackTarget]).toEqual({type: 'failed'})
  })

  it('supports explicit unmapped-event routing when configured', async () => {
    const compiled = compileExpressiveFactory({
      id: 'compiled-route-custom-fallback-factory',
      start: 'decide',
      context: {},
      states: {
        decide: route({
          select: () => 'unknown',
          on: {
            approve: 'done',
            __route_unmapped__: 'manual_fail',
          },
        }),
        manual_fail: {type: 'failed'},
        done: {type: 'done'},
      },
    })

    const decideState = compiled.states.decide
    if (!decideState || decideState.type !== 'orchestrate' || !decideState.select) {
      throw new Error('Expected compiled orchestrate state with select for `decide`')
    }

    const selectRoute = decideState.select as (
      input: {ctx: Record<string, unknown>},
    ) => string | Promise<string>
    const selectedEvent = await selectRoute({ctx: {}})

    expect(selectedEvent).toBe('__route_unmapped__')
    expect(decideState.on[selectedEvent]).toBe('manual_fail')
    expect(compiled.states.decide__route_failed).toBeUndefined()
  })

  it('persists transition events for mapped and unmapped route branches at runtime', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'compiled-route-runtime-factory'
    const mappedTaskExternalId = 'task-compiled-route-runtime-mapped'
    const unmappedTaskExternalId = 'task-compiled-route-runtime-unmapped'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)
    const expressiveModuleUrl = pathToFileURL(
      path.resolve('src/factory/expressive.ts'),
    ).href

    await writeFile(
      factoryPath,
      `import {compileExpressiveFactory, route} from "${expressiveModuleUrl}";\n` +
        `const compiled = compileExpressiveFactory({\n` +
        `  id: "${factoryId}",\n` +
        `  start: "decide",\n` +
        `  context: { decision: "approve" },\n` +
        `  states: {\n` +
        `    decide: route({\n` +
        `      select: ({ ctx }) => String(ctx.decision ?? ""),\n` +
        `      on: { approve: "done", reject: "blocked" }\n` +
        `    }),\n` +
        `    done: { type: "done" },\n` +
        `    blocked: { type: "blocked" }\n` +
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

    await db.insert(schema.tasks).values([
      {
        id: crypto.randomUUID(),
        boardId: factoryId,
        externalTaskId: mappedTaskExternalId,
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
      },
      {
        id: crypto.randomUUID(),
        boardId: factoryId,
        externalTaskId: unmappedTaskExternalId,
        workflowId: factoryId,
        state: 'queued',
        currentStepId: null,
        stepVarsJson: JSON.stringify({decision: 'unexpected'}),
        waitingSince: null,
        lockToken: null,
        lockExpiresAt: null,
        lastError: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ])

    await runtime.runFactoryTaskByExternalId(mappedTaskExternalId)
    await runtime.runFactoryTaskByExternalId(unmappedTaskExternalId)

    const [mappedTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, mappedTaskExternalId))
    expect(mappedTask).toBeTruthy()
    expect(mappedTask?.state).toBe('done')

    const mappedEvents = await db
      .select()
      .from(schema.transitionEvents)
      .where(eq(schema.transitionEvents.taskId, mappedTask!.id))
    expect(mappedEvents).toHaveLength(1)
    expect(mappedEvents[0]?.fromStateId).toBe('decide')
    expect(mappedEvents[0]?.toStateId).toBe('done')
    expect(mappedEvents[0]?.event).toBe('approve')
    expect(mappedEvents[0]?.reason).toBe('orchestrate.select')

    const [unmappedTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, unmappedTaskExternalId))
    expect(unmappedTask).toBeTruthy()
    expect(unmappedTask?.state).toBe('failed')

    const unmappedEvents = await db
      .select()
      .from(schema.transitionEvents)
      .where(eq(schema.transitionEvents.taskId, unmappedTask!.id))
    expect(unmappedEvents).toHaveLength(1)
    expect(unmappedEvents[0]?.fromStateId).toBe('decide')
    expect(unmappedEvents[0]?.toStateId).toBe('decide__route_failed')
    expect(unmappedEvents[0]?.event).toBe('__route_unmapped__')
    expect(unmappedEvents[0]?.reason).toBe('orchestrate.select')
  })
})
