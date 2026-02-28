import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {asc, eq} from 'drizzle-orm'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {compileExpressiveFactory, step} from './expressive'
import type {ActionResult} from './helpers'
import {
  agentSandbox,
  createOrchestrationUtilities,
  invokeAgent,
} from './orchestration'

const homes: string[] = []
const originalHome = process.env.HOME
const originalProjectRoot = process.env.NOTIONFLOW_PROJECT_ROOT

async function setupRuntime() {
  const home = await mkdtemp(
    path.join(tmpdir(), 'notionflow-orchestration-utility-test-'),
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

describe('orchestration utility contracts', () => {
  afterEach(async () => {
    vi.useRealTimers()
    process.env.HOME = originalHome
    process.env.NOTIONFLOW_PROJECT_ROOT = originalProjectRoot
    for (const home of homes.splice(0, homes.length)) {
      await rm(home, {recursive: true, force: true})
    }
  })

  it('supports provider-agnostic injected adapters', async () => {
    const askAdapter = vi.fn(async () => ({
      repo: 'https://github.com/notionflow/demo.git',
    }))
    const invokeAdapter = vi.fn(async ({prompt}: {prompt: string}) => ({
      text: `ack:${prompt}`,
    }))
    const sandboxAdapter = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    }))

    const utilities = createOrchestrationUtilities({
      askForRepo: {
        request: askAdapter,
      },
      invokeAgent: {
        invoke: invokeAdapter,
      },
      agentSandbox: {
        run: sandboxAdapter,
      },
    })

    const repoResult = await utilities.askForRepo({prompt: 'Repo URL?'})
    const invokeResult = await utilities.invokeAgent({prompt: 'Draft a plan.'})
    const sandboxResult = await utilities.agentSandbox({
      command: 'git',
      args: ['status'],
    })

    expect(repoResult).toEqual({
      ok: true,
      value: {repo: 'https://github.com/notionflow/demo.git'},
    })
    expect(invokeResult).toEqual({
      ok: true,
      value: {text: 'ack:Draft a plan.'},
    })
    expect(sandboxResult).toEqual({
      ok: true,
      value: {exitCode: 0, stdout: 'ok', stderr: ''},
    })

    expect(askAdapter).toHaveBeenCalledWith({prompt: 'Repo URL?'})
    expect(invokeAdapter).toHaveBeenCalledWith({prompt: 'Draft a plan.'})
    expect(sandboxAdapter).toHaveBeenCalledWith({
      command: 'git',
      args: ['status'],
    })
  })

  it('can be composed inside primitive step handlers through compileExpressiveFactory', async () => {
    const utilities = createOrchestrationUtilities({
      askForRepo: {
        request: async () => ({
          repo: 'https://github.com/notionflow/composed.git',
        }),
      },
      invokeAgent: {
        invoke: async ({prompt}) => ({
          text: `plan:${prompt}`,
        }),
      },
    })

    const compiled = compileExpressiveFactory({
      id: 'orchestration-utility-compose-factory',
      start: 'collect',
      context: {},
      states: {
        collect: step({
          run: async () => {
            const repo = await utilities.askForRepo({
              prompt: 'Share repo',
            })
            if (!repo.ok) {
              return {status: 'failed', message: repo.error.message}
            }

            const plan = await utilities.invokeAgent({
              prompt: `Plan for ${repo.value.repo}`,
            })
            if (!plan.ok) {
              return {status: 'failed', message: plan.error.message}
            }

            return {
              status: 'done',
              data: {
                repo_url: repo.value.repo,
                plan: plan.value.text,
              },
            }
          },
          on: {done: 'done', failed: 'failed'},
        }),
        done: {type: 'done'},
        failed: {type: 'failed'},
      },
    })

    const collectState = compiled.states.collect
    if (!collectState || collectState.type !== 'action') {
      throw new Error('Expected compiled action state for `collect`')
    }

    const result = await (
      collectState.agent as (input: {
        ctx: Record<string, unknown>
      }) => Promise<ActionResult<Record<string, unknown>>>
    )({ctx: {}})
    expect(result.status).toBe('done')
    expect(result.data).toEqual({
      repo_url: 'https://github.com/notionflow/composed.git',
      plan: 'plan:Plan for https://github.com/notionflow/composed.git',
    })
  })

  it('executes compiled utility workflows through runtime entry points and persists context and transitions', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'orchestration-utility-runtime-factory'
    const externalTaskId = 'task-orchestration-utility-runtime-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)
    const expressiveModuleUrl = pathToFileURL(
      path.resolve('src/factory/expressive.ts'),
    ).href
    const orchestrationModuleUrl = pathToFileURL(
      path.resolve('src/factory/orchestration.ts'),
    ).href

    await writeFile(
      factoryPath,
      `import {compileExpressiveFactory, step} from "${expressiveModuleUrl}";\n` +
        `import {createOrchestrationUtilities} from "${orchestrationModuleUrl}";\n` +
        `const utilities = createOrchestrationUtilities({\n` +
        `  askForRepo: {\n` +
        `    request: async () => ({ repo: "https://github.com/notionflow/integration.git", branch: "main" })\n` +
        `  },\n` +
        `  invokeAgent: {\n` +
        `    invoke: async ({ prompt }) => ({ text: \`plan:\${prompt}\` })\n` +
        `  },\n` +
        `  agentSandbox: {\n` +
        `    run: async () => ({ exitCode: 0, stdout: "M README.md", stderr: "" })\n` +
        `  }\n` +
        `});\n` +
        `const compiled = compileExpressiveFactory({\n` +
        `  id: "${factoryId}",\n` +
        `  start: "collect_repo",\n` +
        `  context: {},\n` +
        `  states: {\n` +
        `    collect_repo: step({\n` +
        `      run: async () => {\n` +
        `        const repo = await utilities.askForRepo({ prompt: "Share repo URL" });\n` +
        `        if (!repo.ok) return { status: "failed", message: repo.error.message };\n` +
        `        return {\n` +
        `          status: "done",\n` +
        `          data: {\n` +
        `            repo_url: repo.value.repo,\n` +
        `            repo_branch: repo.value.branch ?? "unknown"\n` +
        `          }\n` +
        `        };\n` +
        `      },\n` +
        `      on: { done: "draft_plan", failed: "failed" }\n` +
        `    }),\n` +
        `    draft_plan: step({\n` +
        `      run: async ({ ctx }) => {\n` +
        `        const repoUrl = String(ctx.repo_url ?? "");\n` +
        `        const plan = await utilities.invokeAgent({ prompt: \`Plan for \${repoUrl}\` });\n` +
        `        if (!plan.ok) return { status: "failed", message: plan.error.message };\n` +
        `        const sandbox = await utilities.agentSandbox({ command: "git", args: ["status", "--short"] });\n` +
        `        if (!sandbox.ok) return { status: "failed", message: sandbox.error.message };\n` +
        `        return {\n` +
        `          status: "done",\n` +
        `          data: {\n` +
        `            plan_text: plan.value.text,\n` +
        `            sandbox_stdout: sandbox.value.stdout\n` +
        `          }\n` +
        `        };\n` +
        `      },\n` +
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
    const persistedContext = JSON.parse(
      updatedTask?.stepVarsJson ?? '{}',
    ) as Record<string, unknown>
    expect(persistedContext.repo_url).toBe(
      'https://github.com/notionflow/integration.git',
    )
    expect(persistedContext.repo_branch).toBe('main')
    expect(persistedContext.plan_text).toBe(
      'plan:Plan for https://github.com/notionflow/integration.git',
    )
    expect(persistedContext.sandbox_stdout).toBe('M README.md')

    const events = await db
      .select()
      .from(schema.transitionEvents)
      .where(eq(schema.transitionEvents.taskId, updatedTask!.id))
      .orderBy(
        asc(schema.transitionEvents.timestamp),
        asc(schema.transitionEvents.id),
      )

    expect(events).toHaveLength(2)
    expect(events[0]?.fromStateId).toBe('collect_repo')
    expect(events[0]?.toStateId).toBe('draft_plan')
    expect(events[0]?.event).toBe('done')
    expect(events[0]?.reason).toBe('action.done')
    expect(events[1]?.fromStateId).toBe('draft_plan')
    expect(events[1]?.toStateId).toBe('done')
    expect(events[1]?.event).toBe('done')
    expect(events[1]?.reason).toBe('action.done')
  })

  it('returns adapter errors when adapter execution fails', async () => {
    const result = await invokeAgent(
      {prompt: 'Implement feature branch'},
      {
        adapter: {
          invoke: async () => {
            throw new Error('provider unavailable')
          },
        },
      },
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('Expected invokeAgent to fail')
    }

    expect(result.error.code).toBe('adapter_error')
    expect(result.error.message).toContain('provider unavailable')
  })

  it('returns timeout errors for long-running adapters', async () => {
    vi.useFakeTimers()

    const resultPromise = agentSandbox(
      {
        command: 'git',
        args: ['status'],
        timeoutMs: 50,
      },
      {
        adapter: {
          run: async () =>
            new Promise<never>(() => {
              // Intentionally never resolves to force timeout handling.
            }),
        },
      },
    )

    await vi.advanceTimersByTimeAsync(50)
    const result = await resultPromise

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('Expected agentSandbox timeout failure')
    }

    expect(result.error.code).toBe('timeout')
    expect(result.error.message).toContain('timed out')
  })

  it('provides default adapter structures that are overridable via injection', async () => {
    const utilities = createOrchestrationUtilities()
    const result = await utilities.askForRepo({prompt: 'Repo URL?'})

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('Expected missing adapter failure')
    }

    expect(result.error.code).toBe('adapter_error')
    expect(result.error.message).toContain('No adapter configured for askForRepo')
  })
})
