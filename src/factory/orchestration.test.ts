import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {asc, eq} from 'drizzle-orm'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {definePipe, end, flow, step} from './canonical'
import {
  agentSandbox,
  agentSandboxEffect,
  askForRepoEffect,
  createOrchestrationTestLayer,
  createOrchestrationUtilities,
  createOrchestrationUtilitiesFromLayer,
  invokeAgent,
  invokeAgentEffect,
  runOrchestrationEffect,
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

function transitionLike<T extends {type: string | null}>(traces: T[]): T[] {
  return traces.filter(trace => trace.type === 'step' || trace.type === 'retry')
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

  it('runs layer-backed orchestration effects for success cases', async () => {
    const layer = createOrchestrationTestLayer({
      askForRepo: async () => ({
        repo: 'https://github.com/notionflow/demo.git',
      }),
      invokeAgent: async ({prompt}) => ({
        text: `ack:${prompt}`,
      }),
      agentSandbox: async () => ({
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
      }),
    })

    const repoResult = await runOrchestrationEffect(
      askForRepoEffect({prompt: 'Repo URL?'}),
      layer,
    )
    const invokeResult = await runOrchestrationEffect(
      invokeAgentEffect({prompt: 'Draft a plan.'}),
      layer,
    )
    const sandboxResult = await runOrchestrationEffect(
      agentSandboxEffect({
        command: 'git',
        args: ['status'],
      }),
      layer,
    )

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

  it('supports provider swapping via injected test layers in compiled workflows', async () => {
    const runScenario = async (
      providerName: 'alpha' | 'beta',
    ): Promise<Record<string, unknown>> => {
      const layer = createOrchestrationTestLayer({
        askForRepo: async () => ({
          repo: `https://github.com/notionflow/${providerName}.git`,
        }),
        invokeAgent: async ({prompt}) => ({
          text: `${providerName}:${prompt}`,
        }),
      })
      const utilities = createOrchestrationUtilitiesFromLayer(layer)

      const pipe = definePipe({
        id: `orchestration-provider-swap-${providerName}`,
        initial: {},
        run: flow(
          step('collect', async ctx => {
            const repo = await utilities.askForRepo({
              prompt: 'Share repo',
            })
            if (!repo.ok) {
              return {
                ...ctx,
                provider: providerName,
                error: repo.error.message,
              }
            }

            const plan = await utilities.invokeAgent({
              prompt: `Plan for ${repo.value.repo}`,
            })
            if (!plan.ok) {
              return {
                ...ctx,
                provider: providerName,
                error: plan.error.message,
              }
            }

            return {
              ...ctx,
              provider: providerName,
              repo_url: repo.value.repo,
              plan: plan.value.text,
            }
          }),
          end.done(),
        ),
      })

      const result = await pipe.run({
        ctx: pipe.initial,
        runId: `run-${providerName}`,
        tickId: `tick-${providerName}`,
      })
      if (
        !result ||
        typeof result !== 'object' ||
        !('type' in result) ||
        !('status' in result) ||
        !('ctx' in result) ||
        result.type !== 'end' ||
        result.status !== 'done'
      ) {
        throw new Error('Expected pipe to terminate with end.done()')
      }
      return result.ctx as Record<string, unknown>
    }

    const alphaResult = await runScenario('alpha')
    const betaResult = await runScenario('beta')

    expect(alphaResult).toEqual({
      provider: 'alpha',
      repo_url: 'https://github.com/notionflow/alpha.git',
      plan: 'alpha:Plan for https://github.com/notionflow/alpha.git',
    })
    expect(betaResult).toEqual({
      provider: 'beta',
      repo_url: 'https://github.com/notionflow/beta.git',
      plan: 'beta:Plan for https://github.com/notionflow/beta.git',
    })
  })

  it('executes compiled utility workflows through runtime entry points and persists context and transitions', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'orchestration-utility-runtime-factory'
    const externalTaskId = 'task-orchestration-utility-runtime-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)
    const canonicalModuleUrl = pathToFileURL(
      path.resolve('src/factory/canonical.ts'),
    ).href
    const orchestrationModuleUrl = pathToFileURL(
      path.resolve('src/factory/orchestration.ts'),
    ).href

    await writeFile(
      factoryPath,
      `import {definePipe, end, flow, step} from "${canonicalModuleUrl}";\n` +
        `import {createOrchestrationTestLayer, createOrchestrationUtilitiesFromLayer} from "${orchestrationModuleUrl}";\n` +
        `const utilityLayer = createOrchestrationTestLayer({\n` +
        `  askForRepo: async () => ({ repo: "https://github.com/notionflow/integration.git", branch: "main" }),\n` +
        `  invokeAgent: async ({ prompt }) => ({ text: \`plan:\${prompt}\` }),\n` +
        `  agentSandbox: async () => ({ exitCode: 0, stdout: "M README.md", stderr: "" })\n` +
        `});\n` +
        `const utilities = createOrchestrationUtilitiesFromLayer(utilityLayer);\n` +
        `const pipe = definePipe({\n` +
        `  id: "${factoryId}",\n` +
        `  initial: {},\n` +
        `  run: flow(\n` +
        `    step("collect_repo", async ctx => {\n` +
        `        const repo = await utilities.askForRepo({ prompt: "Share repo URL" });\n` +
        `        if (!repo.ok) return { ...ctx, error: repo.error.message };\n` +
        `        return {\n` +
        `          ...ctx,\n` +
        `            repo_url: repo.value.repo,\n` +
        `            repo_branch: repo.value.branch ?? "unknown"\n` +
        `        };\n` +
        `      }),\n` +
        `    step("draft_plan", async ctx => {\n` +
        `        const repoUrl = String(ctx.repo_url ?? "");\n` +
        `        const plan = await utilities.invokeAgent({ prompt: \`Plan for \${repoUrl}\` });\n` +
        `        if (!plan.ok) return { ...ctx, error: plan.error.message };\n` +
        `        const sandbox = await utilities.agentSandbox({ command: "git", args: ["status", "--short"] });\n` +
        `        if (!sandbox.ok) return { ...ctx, error: sandbox.error.message };\n` +
        `        return {\n` +
        `          ...ctx,\n` +
        `            plan_text: plan.value.text,\n` +
        `            sandbox_stdout: sandbox.value.stdout\n` +
        `        };\n` +
        `      }),\n` +
        `    end.done(),\n` +
        `  ),\n` +
        `});\n` +
        `export default pipe;\n`,
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

    const events = transitionLike(
      await db
        .select()
        .from(schema.runTraces)
        .where(eq(schema.runTraces.taskId, updatedTask!.id))
        .orderBy(
          asc(schema.runTraces.timestamp),
          asc(schema.runTraces.id),
        ),
    )

    expect(events).toHaveLength(1)
    expect(events[0]?.fromStateId).toBe('__pipe_run__')
    expect(events[0]?.toStateId).toBe('__pipe_done__')
    expect(events[0]?.event).toBe('done')
    expect(events[0]?.reason).toBe('action.done')
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
