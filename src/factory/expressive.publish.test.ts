import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {eq} from 'drizzle-orm'
import {afterEach, describe, expect, it, vi} from 'vitest'
import type {ActionResult} from './helpers'
import {compileExpressiveFactory, publish} from './expressive'

const homes: string[] = []
const originalHome = process.env.HOME
const originalProjectRoot = process.env.NOTIONFLOW_PROJECT_ROOT

async function setupRuntime() {
  const home = await mkdtemp(
    path.join(tmpdir(), 'notionflow-expressive-publish-test-'),
  )
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

describe('expressive publish compilation', () => {
  afterEach(async () => {
    process.env.HOME = originalHome
    process.env.NOTIONFLOW_PROJECT_ROOT = originalProjectRoot
    for (const home of homes.splice(0, homes.length)) {
      await rm(home, {recursive: true, force: true})
    }
  })

  it('compiles publish primitives into action states that emit markdown page output', async () => {
    const compiled = compileExpressiveFactory({
      id: 'compiled-publish-shape-factory',
      start: 'publish_report',
      context: {score: 1},
      states: {
        publish_report: publish({
          render: async ({ctx}) => ({markdown: `# Score ${ctx.score}`}),
        }),
        done: {type: 'done'},
        failed: {type: 'failed'},
      },
    })

    const publishState = compiled.states.publish_report
    if (!publishState || publishState.type !== 'action') {
      throw new Error('Expected compiled action state for `publish_report`')
    }

    expect(publishState.on).toEqual({done: 'done', failed: 'failed'})

    const publishResult = await (
      publishState.agent as (input: {
        ctx: Record<string, unknown>
      }) => Promise<ActionResult<Record<string, unknown>>>
    )({
      ctx: {score: 3},
    })

    expect(publishResult.status).toBe('done')
    expect(publishResult.page).toEqual({markdown: '# Score 3'})
  })

  it('executes compiled publish workflows via runFactoryTaskByExternalId', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'compiled-publish-runtime-factory'
    const externalTaskId = 'task-compiled-publish-runtime-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)
    const expressiveModuleUrl = pathToFileURL(
      path.resolve('src/factory/expressive.ts'),
    ).href

    await writeFile(
      factoryPath,
      `import {compileExpressiveFactory, publish} from "${expressiveModuleUrl}";\n` +
        `const compiled = compileExpressiveFactory({\n` +
        `  id: "${factoryId}",\n` +
        `  start: "publish_report",\n` +
        `  context: { score: 7 },\n` +
        `  states: {\n` +
        `    publish_report: publish({\n` +
        `      render: async ({ ctx }) => ({ markdown: \`# Final Score\\n\\n\${Number(ctx.score ?? 0)}\` }),\n` +
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
    expect(doneCtx.score).toBe(7)

    const events = await db
      .select()
      .from(schema.transitionEvents)
      .where(eq(schema.transitionEvents.taskId, updatedTask!.id))
    expect(events).toHaveLength(1)
    expect(events[0]?.fromStateId).toBe('publish_report')
    expect(events[0]?.toStateId).toBe('done')
    expect(events[0]?.event).toBe('done')
    expect(events[0]?.reason).toBe('action.done')
  })
})
