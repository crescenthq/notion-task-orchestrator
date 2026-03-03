import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {asc, eq} from 'drizzle-orm'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {definePipe, end, flow, step} from './canonical'
import {askForRepo} from './helpers/askForRepo'
import {createOrchestration} from './orchestration'

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

  it('createOrchestration returns bound utilities', async () => {
    const utilities = createOrchestration({
      invokeAgent: async ({prompt}) => ({text: `ack:${prompt}`}),
      runCommand: async ({command}) => ({
        exitCode: 0,
        stdout: command,
        stderr: '',
      }),
    })

    const invokeResult = await utilities.invokeAgent({prompt: 'plan'})
    const commandResult = await utilities.runCommand({command: 'git'})

    expect(invokeResult).toEqual({
      ok: true,
      value: {text: 'ack:plan'},
    })
    expect(commandResult).toEqual({
      ok: true,
      value: {exitCode: 0, stdout: 'git', stderr: ''},
    })
  })

  it('returns adapter_error when provider throws', async () => {
    const utilities = createOrchestration({
      invokeAgent: async () => {
        throw new Error('provider unavailable')
      },
      runCommand: async () => ({exitCode: 0, stdout: '', stderr: ''}),
    })

    const result = await utilities.invokeAgent({prompt: 'Implement feature branch'})

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('Expected invokeAgent to fail')
    }

    expect(result.error.code).toBe('adapter_error')
    expect(result.error.message).toContain('provider unavailable')
  })

  it('returns timeout errors for long-running providers', async () => {
    vi.useFakeTimers()

    const utilities = createOrchestration({
      invokeAgent: async () =>
        new Promise<never>(() => {
          // Intentionally never resolves to force timeout handling.
        }),
      runCommand: async () => ({exitCode: 0, stdout: '', stderr: ''}),
    })

    const resultPromise = utilities.invokeAgent({prompt: 'x', timeoutMs: 50})

    await vi.advanceTimersByTimeAsync(50)
    const result = await resultPromise

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('Expected invokeAgent timeout failure')
    }

    expect(result.error.code).toBe('timeout')
    expect(result.error.message).toContain('timed out')
  })

  it('swaps providers for testing without ceremony', async () => {
    const alpha = createOrchestration({
      invokeAgent: async () => ({text: 'alpha'}),
      runCommand: async () => ({exitCode: 0, stdout: '', stderr: ''}),
    })
    const beta = createOrchestration({
      invokeAgent: async () => ({text: 'beta'}),
      runCommand: async () => ({exitCode: 0, stdout: '', stderr: ''}),
    })

    const a = await alpha.invokeAgent({prompt: 'x'})
    const b = await beta.invokeAgent({prompt: 'x'})

    if (a.ok && b.ok) {
      expect(a.value.text).toBe('alpha')
      expect(b.value.text).toBe('beta')
    }
  })

  it('askForRepo helper extracts repo from structured agent output', async () => {
    const utilities = createOrchestration({
      invokeAgent: async () => ({
        text: 'Here is the repo.',
        structured: {repo: 'https://github.com/org/repo.git', branch: 'main'},
      }),
      runCommand: async () => ({exitCode: 0, stdout: '', stderr: ''}),
    })

    const result = await askForRepo(utilities, 'Share repo')

    expect(result).toEqual({
      ok: true,
      value: {repo: 'https://github.com/org/repo.git', branch: 'main'},
    })
  })

  it('askForRepo helper returns adapter_error when repo is missing', async () => {
    const utilities = createOrchestration({
      invokeAgent: async () => ({
        text: 'I could not parse one.',
        structured: {branch: 'main'},
      }),
      runCommand: async () => ({exitCode: 0, stdout: '', stderr: ''}),
    })

    const result = await askForRepo(utilities, 'Share repo')

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('Expected askForRepo helper to fail')
    }

    expect(result.error.code).toBe('adapter_error')
    expect(result.error.message).toBe('Agent did not return a repo URL')
  })

  it('supports provider swapping in compiled workflows', async () => {
    const runScenario = async (
      providerName: 'alpha' | 'beta',
    ): Promise<Record<string, unknown>> => {
      const utilities = createOrchestration({
        invokeAgent: async ({prompt}) => {
          if (prompt.includes('Share repo')) {
            return {
              text: `repo:${providerName}`,
              structured: {
                repo: `https://github.com/notionflow/${providerName}.git`,
              },
            }
          }

          return {
            text: `${providerName}:${prompt}`,
          }
        },
        runCommand: async () => ({exitCode: 0, stdout: '', stderr: ''}),
      })

      const pipe = definePipe({
        id: `orchestration-provider-swap-${providerName}`,
        initial: {},
        run: flow(
          step('collect', async ctx => {
            const repo = await askForRepo(utilities, 'Share repo')
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
    const askForRepoModuleUrl = pathToFileURL(
      path.resolve('src/factory/helpers/askForRepo.ts'),
    ).href

    await writeFile(
      factoryPath,
      `import {definePipe, end, flow, step} from "${canonicalModuleUrl}";\n` +
        `import {createOrchestration} from "${orchestrationModuleUrl}";\n` +
        `import {askForRepo} from "${askForRepoModuleUrl}";\n` +
        `const utilities = createOrchestration({\n` +
        `  invokeAgent: async ({prompt, schema}) => {\n` +
        `    if (schema && schema.repo) {\n` +
        `      return {\n` +
        `        text: "repo-response",\n` +
        `        structured: {repo: "https://github.com/notionflow/integration.git", branch: "main"},\n` +
        `      };\n` +
        `    }\n` +
        `    return {text: \`plan:\${prompt}\`};\n` +
        `  },\n` +
        `  runCommand: async () => ({exitCode: 0, stdout: "M README.md", stderr: ""}),\n` +
        `});\n` +
        `const pipe = definePipe({\n` +
        `  id: "${factoryId}",\n` +
        `  initial: {},\n` +
        `  run: flow(\n` +
        `    step("collect_repo", async ctx => {\n` +
        `      const repo = await askForRepo(utilities, "Share repo URL");\n` +
        `      if (!repo.ok) return {...ctx, error: repo.error.message};\n` +
        `      return {\n` +
        `        ...ctx,\n` +
        `        repo_url: repo.value.repo,\n` +
        `        repo_branch: repo.value.branch ?? "unknown"\n` +
        `      };\n` +
        `    }),\n` +
        `    step("draft_plan", async ctx => {\n` +
        `      const repoUrl = String(ctx.repo_url ?? "");\n` +
        `      const plan = await utilities.invokeAgent({prompt: \`Plan for \${repoUrl}\`});\n` +
        `      if (!plan.ok) return {...ctx, error: plan.error.message};\n` +
        `      const command = await utilities.runCommand({command: "git", args: ["status", "--short"]});\n` +
        `      if (!command.ok) return {...ctx, error: command.error.message};\n` +
        `      return {\n` +
        `        ...ctx,\n` +
        `        plan_text: plan.value.text,\n` +
        `        command_stdout: command.value.stdout\n` +
        `      };\n` +
        `    }),\n` +
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
    expect(persistedContext.command_stdout).toBe('M README.md')

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
})
