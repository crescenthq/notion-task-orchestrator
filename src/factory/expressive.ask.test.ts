import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {eq} from 'drizzle-orm'
import {afterEach, describe, expect, it, vi} from 'vitest'
import type {ActionResult} from './helpers'
import {ask, compileExpressiveFactory} from './expressive'

const homes: string[] = []
const originalHome = process.env.HOME
const originalProjectRoot = process.env.NOTIONFLOW_PROJECT_ROOT

async function setupRuntime() {
  const home = await mkdtemp(path.join(tmpdir(), 'notionflow-expressive-ask-test-'))
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

function compileAskAgent() {
  const compiled = compileExpressiveFactory({
    id: 'compiled-ask-parse-factory',
    start: 'collect_feedback',
    context: {},
    states: {
      collect_feedback: ask({
        prompt: 'Reply with "approve" to continue.',
        parse: reply => {
          if (reply.trim().toLowerCase() === 'approve') {
            return {
              status: 'done',
              data: {approved: true},
            }
          }

          return {
            status: 'feedback',
            data: {approved: false},
          }
        },
        on: {
          done: 'done',
          failed: 'failed',
        },
      }),
      done: {type: 'done'},
      failed: {type: 'failed'},
    },
  })

  const collectState = compiled.states.collect_feedback
  if (!collectState || collectState.type !== 'action') {
    throw new Error('Expected compiled action state for `collect_feedback`')
  }

  return collectState.agent as (input: {
    ctx: Record<string, unknown>
    feedback?: string
  }) => Promise<ActionResult<Record<string, unknown>>>
}

describe('expressive ask compilation', () => {
  afterEach(async () => {
    process.env.HOME = originalHome
    process.env.NOTIONFLOW_PROJECT_ROOT = originalProjectRoot
    for (const home of homes.splice(0, homes.length)) {
      await rm(home, {recursive: true, force: true})
    }
  })

  it('compiles ask primitives into action and feedback states with explicit resume targets', () => {
    const compiled = compileExpressiveFactory({
      id: 'compiled-ask-shape-factory',
      start: 'collect_feedback',
      context: {attempts: 0},
      states: {
        collect_feedback: ask({
          prompt: 'Please provide approval feedback.',
          on: {
            done: 'done',
            feedback: 'review_summary',
            failed: 'failed',
          },
          resume: 'review_summary',
        }),
        review_summary: {type: 'done'},
        done: {type: 'done'},
        failed: {type: 'failed'},
      },
    })

    const collectState = compiled.states.collect_feedback
    if (!collectState || collectState.type !== 'action') {
      throw new Error('Expected compiled action state for `collect_feedback`')
    }

    const feedbackState = compiled.states.collect_feedback__feedback
    if (!feedbackState || feedbackState.type !== 'feedback') {
      throw new Error('Expected generated feedback state for `collect_feedback`')
    }

    expect(collectState.on.done).toBe('done')
    expect(collectState.on.feedback).toBe('collect_feedback__feedback')
    expect(collectState.on.failed).toBe('failed')
    expect(feedbackState.resume).toBe('review_summary')
  })

  it('returns feedback with the prompt when reply is missing', async () => {
    const askAgent = compileAskAgent()
    const missingReply = await askAgent({ctx: {}})
    expect(missingReply.status).toBe('feedback')
    expect(missingReply.message).toBe('Reply with "approve" to continue.')
    expect(missingReply.data).toEqual({human_feedback: undefined})
  })

  it('returns feedback with retry messaging when reply is invalid', async () => {
    const askAgent = compileAskAgent()
    const invalidReply = await askAgent({ctx: {human_feedback: 'no'}})
    expect(invalidReply.status).toBe('feedback')
    expect(invalidReply.message).toBe('Reply with "approve" to continue.')
    expect(invalidReply.data).toEqual({
      approved: false,
      human_feedback: undefined,
    })
  })

  it('returns done when reply is valid', async () => {
    const askAgent = compileAskAgent()
    const validReply = await askAgent({
      ctx: {human_feedback: 'approve'},
    })
    expect(validReply.status).toBe('done')
    expect(validReply.data).toEqual({
      approved: true,
      human_feedback: undefined,
    })
  })

  it('persists feedback pause state and resumes compiled ask workflows', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'compiled-ask-runtime-factory'
    const externalTaskId = 'task-compiled-ask-runtime-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)
    const expressiveModuleUrl = pathToFileURL(
      path.resolve('src/factory/expressive.ts'),
    ).href

    await writeFile(
      factoryPath,
      `import {ask, compileExpressiveFactory} from "${expressiveModuleUrl}";\n` +
        `const compiled = compileExpressiveFactory({\n` +
        `  id: "${factoryId}",\n` +
        `  start: "collect_feedback",\n` +
        `  context: { reviewCount: 0 },\n` +
        `  states: {\n` +
        `    collect_feedback: ask({\n` +
        `      prompt: "Reply with approve to continue.",\n` +
        `      parse: (reply) => {\n` +
        `        if (reply.trim().toLowerCase() === "approve") {\n` +
        `          return { status: "done", data: { approved: true } };\n` +
        `        }\n` +
        `        return { status: "feedback", data: { approved: false } };\n` +
        `      },\n` +
        `      on: { done: "review_summary", failed: "failed" },\n` +
        `      resume: "collect_feedback"\n` +
        `    }),\n` +
        `    review_summary: {\n` +
        `      type: "action",\n` +
        `      agent: async ({ ctx }) => ({\n` +
        `        status: "done",\n` +
        `        data: { reviewCount: Number(ctx.reviewCount ?? 0) + 1 }\n` +
        `      }),\n` +
        `      on: { done: "done", failed: "failed" }\n` +
        `    },\n` +
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

    const [paused] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(paused?.state).toBe('feedback')
    expect(paused?.currentStepId).toBe('collect_feedback')
    const pausedCtx = JSON.parse(paused?.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    expect(pausedCtx.reviewCount).toBe(0)
    expect(pausedCtx.human_feedback).toBeUndefined()

    const resumedCtx = {...pausedCtx, human_feedback: 'approve'}
    await db
      .update(schema.tasks)
      .set({
        state: 'queued',
        stepVarsJson: JSON.stringify(resumedCtx),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.tasks.externalTaskId, externalTaskId))

    await runtime.runFactoryTaskByExternalId(externalTaskId)

    const [doneTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(doneTask?.state).toBe('done')
    expect(doneTask).toBeTruthy()
    const doneCtx = JSON.parse(doneTask?.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    expect(doneCtx.approved).toBe(true)
    expect(doneCtx.reviewCount).toBe(1)
    expect(doneCtx.human_feedback).toBeUndefined()

    const events = await db
      .select()
      .from(schema.transitionEvents)
      .where(eq(schema.transitionEvents.taskId, doneTask!.id))
    expect(
      events.map(event => `${event.fromStateId}->${event.toStateId}`),
    ).toEqual([
      'collect_feedback->collect_feedback__feedback',
      'collect_feedback->review_summary',
      'review_summary->done',
    ])
    expect(events.map(event => event.event)).toEqual(['feedback', 'done', 'done'])
    expect(events.map(event => event.reason)).toEqual([
      'action.feedback',
      'action.done',
      'action.done',
    ])
  })
})
