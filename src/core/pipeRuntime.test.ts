import {execFile} from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {eq} from 'drizzle-orm'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {replayRunTraces} from './runTraces'

const homes: string[] = []
const originalHome = process.env.HOME
const originalProjectRoot = process.env.PIPES_PROJECT_ROOT

async function setupRuntime(
  options: {configSource?: string; projectSubdir?: string} = {},
) {
  const home = await mkdtemp(path.join(tmpdir(), 'pipes-runtime-test-'))
  homes.push(home)
  const projectRoot = options.projectSubdir
    ? path.join(home, options.projectSubdir)
    : home

  await initGitRepo(home)
  process.env.HOME = home
  process.env.PIPES_PROJECT_ROOT = projectRoot
  await mkdir(projectRoot, {recursive: true})
  await writeFile(
    path.join(projectRoot, 'pipes.config.ts'),
    options.configSource ?? 'export default { pipes: [] };\n',
    'utf8',
  )
  await commitAll(home, 'initial runtime project')
  vi.resetModules()

  const [{nowIso, openApp}, {paths}, runtime, schema] = await Promise.all([
    import('../app/context'),
    import('../config/paths'),
    import('./pipeRuntime'),
    import('../db/schema'),
  ])

  const {db} = await openApp()
  const timestamp = nowIso()
  return {db, paths, runtime, schema, timestamp, projectRoot, repoRoot: home}
}

async function insertQueuedTask(input: {
  db: Awaited<ReturnType<typeof setupRuntime>>['db']
  schema: Awaited<ReturnType<typeof setupRuntime>>['schema']
  timestamp: string
  factoryId: string
  externalTaskId: string
}): Promise<void> {
  await input.db.insert(input.schema.boards).values({
    id: input.factoryId,
    adapter: 'local',
    externalId: 'local-board',
    configJson: '{}',
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  })

  await input.db.insert(input.schema.workflows).values({
    id: input.factoryId,
    version: 1,
    definitionYaml: '{}',
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  })

  await input.db.insert(input.schema.tasks).values({
    id: crypto.randomUUID(),
    boardId: input.factoryId,
    externalTaskId: input.externalTaskId,
    workflowId: input.factoryId,
    state: 'queued',
    currentStepId: null,
    stepVarsJson: null,
    waitingSince: null,
    lockToken: null,
    lockExpiresAt: null,
    lastError: null,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  })
}

function transitionLike<T extends {type: string | null}>(traces: T[]): T[] {
  return traces.filter(trace => trace.type === 'step' || trace.type === 'retry')
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }

    throw error
  }
}

describe('pipeRuntime (definePipe only)', () => {
  afterEach(async () => {
    process.env.HOME = originalHome
    process.env.PIPES_PROJECT_ROOT = originalProjectRoot
    for (const home of homes.splice(0, homes.length)) {
      await rm(home, {recursive: true, force: true})
    }
  })

  it('executes direct pipe factories and persists task/run state', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'runtime-direct-pipe-factory'
    const externalTaskId = 'task-direct-pipe-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)

    await writeFile(
      factoryPath,
      `export default {\n` +
        `  id: "${factoryId}",\n` +
        `  initial: { visits: 0 },\n` +
        `  run: async ({ ctx, writePage }) => {\n` +
        `    await writePage({ markdown: "# Pipe Output" });\n` +
        `    return { ...ctx, visits: Number(ctx.visits ?? 0) + 1, finishedBy: "pipe" };\n` +
        `  },\n` +
        `};\n`,
      'utf8',
    )

    await insertQueuedTask({db, schema, timestamp, factoryId, externalTaskId})
    await runtime.runPipeTaskByExternalId(externalTaskId)

    const [updatedTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(updatedTask?.state).toBe('done')
    expect(updatedTask?.currentStepId).toBeNull()

    const persistedCtx = JSON.parse(
      updatedTask?.stepVarsJson ?? '{}',
    ) as Record<string, unknown>
    expect(persistedCtx.visits).toBe(1)
    expect(persistedCtx.finishedBy).toBe('pipe')

    const [run] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, updatedTask!.id))
    expect(run?.status).toBe('done')
    expect(run?.currentStateId).toBeNull()
    expect(run?.endedAt).toBeTruthy()

    const traces = await db
      .select()
      .from(schema.runTraces)
      .where(eq(schema.runTraces.taskId, updatedTask!.id))
    const events = transitionLike(traces)
    expect(events).toHaveLength(1)
    expect(events[0]?.fromStateId).toBe('__pipe_run__')
    expect(events[0]?.toStateId).toBe('__pipe_done__')
    expect(replayRunTraces(events)).toBe('__pipe_done__')

    const traceTypes = new Set(traces.map(trace => trace.type))
    expect(traceTypes.has('started')).toBe(true)
    expect(traceTypes.has('write')).toBe(true)
    expect(traceTypes.has('completed')).toBe(true)
  })

  it('uses an injected task board adapter for board operations', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'runtime-injected-task-board-adapter'
    const externalTaskId = 'task-injected-task-board-adapter-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)

    await writeFile(
      factoryPath,
      `export default {
  id: "${factoryId}",
  initial: { visits: 0 },
  run: async ({ ctx, writePage }) => {
    await writePage({ markdown: "# Adapter Output" });
    return { ...ctx, visits: Number(ctx.visits ?? 0) + 1 };
  },
};
`,
      'utf8',
    )

    await insertQueuedTask({db, schema, timestamp, factoryId, externalTaskId})

    const adapter = {
      kind: 'mock',
      getTask: vi.fn(async (ref: {externalTaskId: string}) => ({
        id: ref.externalTaskId,
        title: 'Injected task title',
        artifact: 'Injected task body',
        comments: [],
      })),
      updateTask: vi.fn(async () => undefined),
      writeArtifact: vi.fn(async () => undefined),
      postComment: vi.fn(async () => undefined),
    }

    await runtime.runPipeTaskByExternalId(externalTaskId, {
      taskBoardAdapter: adapter,
    })

    expect(adapter.getTask).toHaveBeenCalledWith({
      boardId: factoryId,
      externalTaskId,
    })
    expect(adapter.updateTask).toHaveBeenCalledWith(
      expect.objectContaining({externalTaskId}),
      expect.objectContaining({lifecycle: 'in_progress'}),
    )
    expect(adapter.updateTask).toHaveBeenCalledWith(
      expect.objectContaining({externalTaskId}),
      expect.objectContaining({lifecycle: 'done'}),
    )
    expect(adapter.writeArtifact).toHaveBeenCalledWith(
      expect.objectContaining({externalTaskId}),
      '# Adapter Output',
    )
  })

  it('provisions a workspace before direct pipe execution, keys it by run id, and cleans it up on success by default', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'runtime-workspace-provisioning'
    const externalTaskId = 'task-runtime-workspace-provisioning-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)

    await writeFile(
      factoryPath,
      `import {existsSync, readFileSync} from "node:fs";
import path from "node:path";

export default {
  id: "${factoryId}",
  initial: { checks: 0 },
  run: async ({ ctx, runId }) => {
    const projectRoot = process.env.PIPES_PROJECT_ROOT;
    const manifestPath = path.join(
      projectRoot,
      ".pipes-runtime",
      "workspace-manifests",
      \`\${runId}.json\`,
    );
    const workspaceRoot = path.join(
      projectRoot,
      ".pipes-runtime",
      "workspaces",
      runId,
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return {
      ...ctx,
      checks: Number(ctx.checks ?? 0) + 1,
      manifestExistsBeforeRun: existsSync(manifestPath),
      workspaceExistsBeforeRun: existsSync(workspaceRoot),
      workspaceRoot,
      manifestRunId: manifest.runId,
    };
  },
};
`,
      'utf8',
    )

    await insertQueuedTask({db, schema, timestamp, factoryId, externalTaskId})
    await runtime.runPipeTaskByExternalId(externalTaskId)

    const [updatedTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    const persistedCtx = JSON.parse(
      updatedTask?.stepVarsJson ?? '{}',
    ) as Record<string, unknown>

    const [run] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, updatedTask!.id))

    expect(persistedCtx.manifestExistsBeforeRun).toBe(true)
    expect(persistedCtx.workspaceExistsBeforeRun).toBe(true)
    expect(persistedCtx.workspaceRoot).toBe(
      path.join(paths.workspacesDir, run!.id),
    )
    expect(persistedCtx.manifestRunId).toBe(run!.id)
    expect(await pathExists(path.join(paths.workspacesDir, run!.id))).toBe(
      false,
    )
    expect(
      await pathExists(
        path.join(paths.workspaceManifestsDir, `${run!.id}.json`),
      ),
    ).toBe(false)
    expect(await readdir(paths.workspacesDir)).toEqual([])
  })

  it('passes the provisioned workspace handle into pipe execution without changing process.cwd()', async () => {
    const cwdBeforeRun = process.cwd()
    const {db, paths, runtime, schema, timestamp} = await setupRuntime({
      configSource:
        'export default { pipes: [], workspace: { cleanup: "never" } };\n',
      projectSubdir: 'apps/web',
    })
    const factoryId = 'runtime-workspace-handle'
    const externalTaskId = 'task-runtime-workspace-handle-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)

    await writeFile(
      factoryPath,
      `export default {\n` +
        `  id: "${factoryId}",\n` +
        `  initial: {},\n` +
        `  run: async ({ ctx, workspace }) => ({\n` +
        `    ...ctx,\n` +
        `    workspaceRoot: workspace.root,\n` +
        `    workspaceCwd: workspace.cwd,\n` +
        `    workspaceRef: workspace.ref,\n` +
        `    workspaceSourceMode: workspace.source.mode,\n` +
        `    workspaceSourceRepo: workspace.source.repo,\n` +
        `    workspaceRequestedRef: workspace.source.requestedRef,\n` +
        `    processCwdDuringRun: process.cwd(),\n` +
        `  }),\n` +
        `};\n`,
      'utf8',
    )

    await insertQueuedTask({db, schema, timestamp, factoryId, externalTaskId})
    await runtime.runPipeTaskByExternalId(externalTaskId)

    const [updatedTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    const persistedCtx = JSON.parse(
      updatedTask?.stepVarsJson ?? '{}',
    ) as Record<string, unknown>

    const [run] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, updatedTask!.id))
    const manifest = JSON.parse(
      await readFile(
        path.join(paths.workspaceManifestsDir, `${run!.id}.json`),
        'utf8',
      ),
    ) as Record<string, unknown>

    expect(persistedCtx.workspaceRoot).toBe(
      path.join(paths.workspacesDir, run!.id),
    )
    expect(persistedCtx.workspaceCwd).toBe(manifest.cwd)
    expect(persistedCtx.workspaceRef).toBe(manifest.ref)
    expect(persistedCtx.workspaceSourceMode).toBe(manifest.source)
    expect(persistedCtx.workspaceSourceRepo).toBe(manifest.repo)
    expect(persistedCtx.workspaceRequestedRef).toBe(manifest.requestedRef)
    expect(persistedCtx.processCwdDuringRun).toBe(cwdBeforeRun)
    expect(process.cwd()).toBe(cwdBeforeRun)
    expect(persistedCtx.processCwdDuringRun).not.toBe(persistedCtx.workspaceCwd)
  })

  it('retains workspaces for feedback, blocked, and failed outcomes under the default success-only cleanup policy', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const scenarios = [
      {
        externalTaskId: 'task-workspace-retained-feedback-1',
        factoryId: 'runtime-workspace-retained-feedback',
        shouldThrow: false,
        state: 'needs_input',
        source:
          `export default {\n` +
          `  id: "runtime-workspace-retained-feedback",\n` +
          `  initial: {},\n` +
          `  run: async ({ ctx }) => ({\n` +
          `    type: "await_feedback",\n` +
          `    prompt: "Need input",\n` +
          `    ctx,\n` +
          `  }),\n` +
          `};\n`,
      },
      {
        externalTaskId: 'task-workspace-retained-blocked-1',
        factoryId: 'runtime-workspace-retained-blocked',
        shouldThrow: false,
        state: 'needs_input',
        source:
          `export default {\n` +
          `  id: "runtime-workspace-retained-blocked",\n` +
          `  initial: {},\n` +
          `  run: async ({ ctx }) => ({\n` +
          `    type: "end",\n` +
          `    status: "blocked",\n` +
          `    ctx,\n` +
          `  }),\n` +
          `};\n`,
      },
      {
        externalTaskId: 'task-workspace-retained-failed-1',
        factoryId: 'runtime-workspace-retained-failed',
        shouldThrow: true,
        state: 'failed',
        source:
          `export default {\n` +
          `  id: "runtime-workspace-retained-failed",\n` +
          `  initial: {},\n` +
          `  run: async () => {\n` +
          `    throw new Error("boom");\n` +
          `  },\n` +
          `};\n`,
      },
    ] as const

    for (const scenario of scenarios) {
      await writeFile(
        path.join(paths.workflowsDir, `${scenario.factoryId}.mjs`),
        scenario.source,
        'utf8',
      )
      await insertQueuedTask({
        db,
        schema,
        timestamp,
        factoryId: scenario.factoryId,
        externalTaskId: scenario.externalTaskId,
      })

      if (scenario.shouldThrow) {
        await expect(
          runtime.runPipeTaskByExternalId(scenario.externalTaskId),
        ).rejects.toThrow(/Pipe execution failed: boom/)
      } else {
        await runtime.runPipeTaskByExternalId(scenario.externalTaskId)
      }

      const [taskRecord] = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.externalTaskId, scenario.externalTaskId))
      const [runRecord] = await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.taskId, taskRecord!.id))

      expect(taskRecord?.state).toBe(scenario.state)
      expect(
        await pathExists(path.join(paths.workspacesDir, runRecord!.id)),
      ).toBe(true)
      expect(
        await pathExists(
          path.join(paths.workspaceManifestsDir, `${runRecord!.id}.json`),
        ),
      ).toBe(true)
    }
  })

  it('persists direct pipe feedback state and resumes from persisted context', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'runtime-direct-pipe-feedback'
    const externalTaskId = 'task-direct-pipe-feedback-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)

    await writeFile(
      factoryPath,
      `export default {\n` +
        `  id: "${factoryId}",\n` +
        `  initial: { attempts: 0, approved: false },\n` +
        `  run: async ({ ctx }) => {\n` +
        `    const controlBrand = Symbol.for("pipes.control");\n` +
        `    const attempts = Number(ctx.attempts ?? 0) + 1;\n` +
        `    if (!ctx.human_feedback) {\n` +
        `      return {\n` +
        `        [controlBrand]: true,\n` +
        `        type: "await_feedback",\n` +
        `        prompt: "Please approve",\n` +
        `        ctx: { ...ctx, attempts },\n` +
        `      };\n` +
        `    }\n` +
        `    const { human_feedback: _ignored, ...rest } = ctx;\n` +
        `    return {\n` +
        `      [controlBrand]: true,\n` +
        `      type: "end",\n` +
        `      status: "done",\n` +
        `      ctx: { ...rest, attempts, approved: true },\n` +
        `    };\n` +
        `  },\n` +
        `};\n`,
      'utf8',
    )

    await insertQueuedTask({db, schema, timestamp, factoryId, externalTaskId})
    await runtime.runPipeTaskByExternalId(externalTaskId)

    const [paused] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(paused?.state).toBe('needs_input')
    expect(paused?.currentStepId).toBe('__pipe_feedback__')
    const pausedCtx = JSON.parse(paused?.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    expect(pausedCtx.attempts).toBe(1)
    expect(pausedCtx.__nf_feedback_prompt).toBe('Please approve')

    await db
      .update(schema.tasks)
      .set({
        state: 'queued',
        stepVarsJson: JSON.stringify({
          ...pausedCtx,
          human_feedback: 'approved',
        }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.tasks.externalTaskId, externalTaskId))

    await runtime.runPipeTaskByExternalId(externalTaskId)

    const [doneTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(doneTask?.state).toBe('done')
    const doneCtx = JSON.parse(doneTask?.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    expect(doneCtx.attempts).toBe(2)
    expect(doneCtx.approved).toBe(true)
    expect(doneCtx.human_feedback).toBeUndefined()

    const traces = await db
      .select()
      .from(schema.runTraces)
      .where(eq(schema.runTraces.taskId, doneTask!.id))
    const events = transitionLike(traces)
    expect(
      events.map(
        event => `${event.fromStateId}->${event.toStateId}:${event.event}`,
      ),
    ).toEqual([
      '__pipe_run__->__pipe_feedback__:feedback',
      '__pipe_feedback__->__pipe_done__:done',
    ])

    const traceTypes = new Set(traces.map(trace => trace.type))
    expect(traceTypes.has('await_feedback')).toBe(true)
    expect(traceTypes.has('resumed')).toBe(true)
  })

  it('reuses the same run workspace when resuming after feedback', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'runtime-resume-workspace-reuse'
    const externalTaskId = 'task-runtime-resume-workspace-reuse-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)

    await writeFile(
      factoryPath,
      `import {existsSync, readFileSync, writeFileSync} from "node:fs";
import path from "node:path";

export default {
  id: "${factoryId}",
  initial: { attempts: 0 },
  run: async ({ ctx, runId }) => {
    const projectRoot = process.env.PIPES_PROJECT_ROOT;
    const manifestPath = path.join(
      projectRoot,
      ".pipes-runtime",
      "workspace-manifests",
      \`\${runId}.json\`,
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const markerPath = path.join(manifest.root, "resume-marker.txt");
    const attempts = Number(ctx.attempts ?? 0) + 1;

    if (!ctx.human_feedback) {
      writeFileSync(markerPath, runId, "utf8");
      return {
        type: "await_feedback",
        prompt: "resume me",
        ctx: {
          ...ctx,
          attempts,
          firstRunId: runId,
          firstWorkspaceRoot: manifest.root,
        },
      };
    }

    return {
      type: "end",
      status: "done",
      ctx: {
        ...ctx,
        attempts,
        resumedRunId: runId,
        resumedWorkspaceRoot: manifest.root,
        markerPersisted:
          existsSync(markerPath) &&
          readFileSync(markerPath, "utf8") === String(ctx.firstRunId),
      },
    };
  },
};
`,
      'utf8',
    )

    await insertQueuedTask({db, schema, timestamp, factoryId, externalTaskId})
    await runtime.runPipeTaskByExternalId(externalTaskId)

    const [pausedTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(pausedTask?.state).toBe('needs_input')

    const pausedCtx = JSON.parse(pausedTask?.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    const [feedbackRun] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, pausedTask!.id))

    expect(feedbackRun?.status).toBe('needs_input')
    expect(pausedCtx.firstRunId).toBe(feedbackRun?.id)
    expect(pausedCtx.firstWorkspaceRoot).toBe(
      path.join(paths.workspacesDir, feedbackRun!.id),
    )

    await db
      .update(schema.tasks)
      .set({
        state: 'queued',
        stepVarsJson: JSON.stringify({
          ...pausedCtx,
          human_feedback: 'approved',
        }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.tasks.externalTaskId, externalTaskId))

    await runtime.runPipeTaskByExternalId(externalTaskId)

    const [doneTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(doneTask?.state).toBe('done')

    const doneCtx = JSON.parse(doneTask?.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    const taskRuns = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, doneTask!.id))

    expect(taskRuns).toHaveLength(1)
    expect(taskRuns[0]?.id).toBe(feedbackRun?.id)
    expect(taskRuns[0]?.status).toBe('done')
    expect(doneCtx.firstRunId).toBe(feedbackRun?.id)
    expect(doneCtx.resumedRunId).toBe(feedbackRun?.id)
    expect(doneCtx.firstWorkspaceRoot).toBe(
      path.join(paths.workspacesDir, feedbackRun!.id),
    )
    expect(doneCtx.resumedWorkspaceRoot).toBe(
      path.join(paths.workspacesDir, feedbackRun!.id),
    )
    expect(doneCtx.markerPersisted).toBe(true)
  })

  it('resumes from the persisted workspace manifest even if config changes while waiting', async () => {
    const {db, paths, runtime, schema, timestamp, projectRoot, repoRoot} =
      await setupRuntime({
        projectSubdir: path.join('packages', 'app'),
        configSource: 'export default { pipes: [] };\n',
      })
    const canonicalRepoRoot = await realpath(repoRoot)
    const factoryId = 'runtime-resume-persisted-manifest'
    const externalTaskId = 'task-runtime-resume-persisted-manifest-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)
    const alternateRepo = await mkdtemp(
      path.join(tmpdir(), 'pipes-runtime-alt-workspace-'),
    )
    homes.push(alternateRepo)

    await initGitRepo(alternateRepo)
    await writeFile(path.join(alternateRepo, 'README.md'), 'alternate\n', 'utf8')
    await commitAll(alternateRepo, 'alternate workspace repo')

    await writeFile(
      factoryPath,
      `export default {
  id: "${factoryId}",
  initial: { attempts: 0 },
  run: async ({ ctx, runId, workspace }) => {
    const attempts = Number(ctx.attempts ?? 0) + 1;
    if (!ctx.human_feedback) {
      return {
        type: "await_feedback",
        prompt: "resume me",
        ctx: {
          ...ctx,
          attempts,
          firstRunId: runId,
          firstWorkspaceRoot: workspace.root,
          firstWorkspaceRepo: workspace.source.repo,
        },
      };
    }

    return {
      type: "end",
      status: "done",
      ctx: {
        ...ctx,
        attempts,
        resumedRunId: runId,
        resumedWorkspaceRoot: workspace.root,
        resumedWorkspaceRepo: workspace.source.repo,
      },
    };
  },
};
`,
      'utf8',
    )

    await insertQueuedTask({db, schema, timestamp, factoryId, externalTaskId})
    await runtime.runPipeTaskByExternalId(externalTaskId)

    const [pausedTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(pausedTask?.state).toBe('needs_input')

    const [feedbackRun] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, pausedTask!.id))
    const pausedCtx = JSON.parse(pausedTask?.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >

    await writeFile(
      path.join(projectRoot, 'pipes.config.ts'),
      [
        'export default {',
        '  pipes: [],',
        '  workspace: {',
        `    repo: ${JSON.stringify(`file://${alternateRepo}`)},`,
        '    cleanup: "never",',
        '  },',
        '};',
        '',
      ].join('\n'),
      'utf8',
    )

    await db
      .update(schema.tasks)
      .set({
        state: 'queued',
        stepVarsJson: JSON.stringify({
          ...pausedCtx,
          human_feedback: 'approved',
        }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.tasks.externalTaskId, externalTaskId))

    await runtime.runPipeTaskByExternalId(externalTaskId)

    const [doneTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(doneTask?.state).toBe('done')

    const doneCtx = JSON.parse(doneTask?.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    expect(doneCtx.firstRunId).toBe(feedbackRun?.id)
    expect(doneCtx.resumedRunId).toBe(feedbackRun?.id)
    expect(doneCtx.firstWorkspaceRoot).toBe(
      path.join(paths.workspacesDir, feedbackRun!.id),
    )
    expect(doneCtx.resumedWorkspaceRoot).toBe(
      path.join(paths.workspacesDir, feedbackRun!.id),
    )
    expect(doneCtx.firstWorkspaceRepo).toBe(canonicalRepoRoot)
    expect(doneCtx.resumedWorkspaceRepo).toBe(canonicalRepoRoot)

    await expect(pathExists(path.join(paths.workspacesDir, feedbackRun!.id))).resolves.toBe(false)
    await expect(
      pathExists(
        path.join(paths.workspaceManifestsDir, `${feedbackRun!.id}.json`),
      ),
    ).resolves.toBe(false)
  })

  it('fails resumed runs when their original workspace is missing', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'runtime-missing-resume-workspace'
    const externalTaskId = 'task-runtime-missing-resume-workspace-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)

    await writeFile(
      factoryPath,
      `export default {
  id: "${factoryId}",
  initial: { attempts: 0 },
  run: async ({ ctx }) => {
    const attempts = Number(ctx.attempts ?? 0) + 1;
    if (!ctx.human_feedback) {
      return {
        type: "await_feedback",
        prompt: "resume me",
        ctx: { ...ctx, attempts },
      };
    }
    return {
      type: "end",
      status: "done",
      ctx: { ...ctx, attempts },
    };
  },
};
`,
      'utf8',
    )

    await insertQueuedTask({db, schema, timestamp, factoryId, externalTaskId})
    await runtime.runPipeTaskByExternalId(externalTaskId)

    const [pausedTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(pausedTask?.state).toBe('needs_input')

    const [feedbackRun] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, pausedTask!.id))
    const workspacePath = path.join(paths.workspacesDir, feedbackRun!.id)

    await rm(workspacePath, {recursive: true, force: true})

    const pausedCtx = JSON.parse(pausedTask?.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    await db
      .update(schema.tasks)
      .set({
        state: 'queued',
        stepVarsJson: JSON.stringify({
          ...pausedCtx,
          human_feedback: 'approved',
        }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.tasks.externalTaskId, externalTaskId))

    let resumeError: unknown
    try {
      await runtime.runPipeTaskByExternalId(externalTaskId)
    } catch (error) {
      resumeError = error
    }

    expect(resumeError).toBeInstanceOf(Error)
    const resumeMessage = (resumeError as Error).message
    expect(resumeMessage).toContain(
      `Run workspace is missing for resumed run \`${feedbackRun!.id}\`.`,
    )
    expect(resumeMessage).toContain(`worktreePath: ${workspacePath}`)

    const [failedTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(failedTask?.state).toBe('failed')
    expect(failedTask?.lastError).toContain(
      `Run workspace is missing for resumed run \`${feedbackRun!.id}\`.`,
    )
    expect(failedTask?.lastError).toContain(`worktreePath: ${workspacePath}`)

    const taskRuns = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, failedTask!.id))
    expect(taskRuns).toHaveLength(1)
    expect(taskRuns[0]?.id).toBe(feedbackRun?.id)
    expect(taskRuns[0]?.status).toBe('failed')
  })

  it('maps default project workspaces to the project-root-relative cwd for monorepos', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime({
      configSource:
        'export default { pipes: [], workspace: { cleanup: "never" } };\n',
      projectSubdir: path.join('apps', 'web'),
    })
    const factoryId = 'runtime-monorepo-project-workspace'
    const externalTaskId = 'task-runtime-monorepo-project-workspace-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)

    await writeFile(
      factoryPath,
      `export default {
  id: "${factoryId}",
  initial: { ok: false },
  run: async ({ ctx }) => ({ ...ctx, ok: true }),
};
`,
      'utf8',
    )

    await insertQueuedTask({db, schema, timestamp, factoryId, externalTaskId})
    await runtime.runPipeTaskByExternalId(externalTaskId)

    const [updatedTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    const [run] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, updatedTask!.id))

    const manifestPath = path.join(
      paths.workspaceManifestsDir,
      `${run!.id}.json`,
    )
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<
      string,
      string
    >

    expect(manifest.root).toBe(path.join(paths.workspacesDir, run!.id))
    expect(manifest.relativeCwd).toBe(path.join('apps', 'web'))
    expect(manifest.cwd).toBe(path.join(manifest.root, 'apps', 'web'))
    expect(
      await readFile(path.join(manifest.cwd, 'pipes.config.ts'), 'utf8'),
    ).toContain('export default')
  })

  it('coerces unbranded control signals emitted by direct pipe factories', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'runtime-unbranded-control-signals'
    const externalTaskId = 'task-unbranded-control-signals-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)

    await writeFile(
      factoryPath,
      `export default {
  id: "${factoryId}",
  initial: { attempts: 0, approved: false },
  run: async ({ ctx }) => {
    const attempts = Number(ctx.attempts ?? 0) + 1;
    if (!ctx.human_feedback) {
      return {
        type: "await_feedback",
        prompt: "Please approve",
        ctx: { ...ctx, attempts },
      };
    }
    const { human_feedback: _ignored, ...rest } = ctx;
    return {
      type: "end",
      status: "done",
      ctx: { ...rest, attempts, approved: true },
    };
  },
};
`,
      'utf8',
    )

    await insertQueuedTask({db, schema, timestamp, factoryId, externalTaskId})
    await runtime.runPipeTaskByExternalId(externalTaskId)

    const [paused] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(paused?.state).toBe('needs_input')
    expect(paused?.currentStepId).toBe('__pipe_feedback__')
    const pausedCtx = JSON.parse(paused?.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    expect(pausedCtx.attempts).toBe(1)
    expect(pausedCtx.__nf_feedback_prompt).toBe('Please approve')

    await db
      .update(schema.tasks)
      .set({
        state: 'queued',
        stepVarsJson: JSON.stringify({
          ...pausedCtx,
          human_feedback: 'approved',
        }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.tasks.externalTaskId, externalTaskId))

    await runtime.runPipeTaskByExternalId(externalTaskId)

    const [doneTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(doneTask?.state).toBe('done')
    const doneCtx = JSON.parse(doneTask?.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    expect(doneCtx.attempts).toBe(2)
    expect(doneCtx.approved).toBe(true)
    expect(doneCtx.human_feedback).toBeUndefined()
  })

  it('resumes from checkpoints without replaying pre-ask steps', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'runtime-checkpointed-resume'
    const externalTaskId = 'task-runtime-checkpointed-resume-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)
    const canonicalPath = path.join(
      process.cwd(),
      'src',
      'pipe',
      'canonical.ts',
    )

    await writeFile(
      factoryPath,
      `import {ask, definePipe, end, flow, step} from ${JSON.stringify(canonicalPath)};
export default definePipe({
  id: ${JSON.stringify(factoryId)},
  initial: {step_a_runs: 0, step_b_runs: 0, approved_1: false, approved_2: false},
  run: flow(
    step('step-a', ctx => ({...ctx, step_a_runs: Number(ctx.step_a_runs ?? 0) + 1})),
    ask('approval-1', (ctx, reply) => ({...ctx, approved_1: reply.trim().length > 0})),
    step('step-b', ctx => ({...ctx, step_b_runs: Number(ctx.step_b_runs ?? 0) + 1})),
    ask('approval-2', (ctx, reply) => ({...ctx, approved_2: reply.trim().length > 0})),
    end.done(),
  ),
});
`,
      'utf8',
    )

    await insertQueuedTask({db, schema, timestamp, factoryId, externalTaskId})
    await runtime.runPipeTaskByExternalId(externalTaskId)

    const [firstPause] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(firstPause?.state).toBe('needs_input')

    const firstCtx = JSON.parse(firstPause?.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    expect(firstCtx.step_a_runs).toBe(1)
    expect(firstCtx.step_b_runs).toBe(0)
    expect(firstCtx.__nf_checkpoint).toEqual({
      v: 1,
      path: [{k: 'flow', at: 1}],
    })

    await db
      .update(schema.tasks)
      .set({
        state: 'queued',
        stepVarsJson: JSON.stringify({...firstCtx, human_feedback: 'yes-1'}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.tasks.externalTaskId, externalTaskId))

    await runtime.runPipeTaskByExternalId(externalTaskId)

    const [secondPause] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(secondPause?.state).toBe('needs_input')

    const secondCtx = JSON.parse(secondPause?.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    expect(secondCtx.step_a_runs).toBe(1)
    expect(secondCtx.step_b_runs).toBe(1)
    expect(secondCtx.__nf_checkpoint).toEqual({
      v: 1,
      path: [{k: 'flow', at: 3}],
    })

    await db
      .update(schema.tasks)
      .set({
        state: 'queued',
        stepVarsJson: JSON.stringify({...secondCtx, human_feedback: 'yes-2'}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.tasks.externalTaskId, externalTaskId))

    await runtime.runPipeTaskByExternalId(externalTaskId)

    const [doneTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))

    expect(doneTask?.state).toBe('done')
    const doneCtx = JSON.parse(doneTask?.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    expect(doneCtx.step_a_runs).toBe(1)
    expect(doneCtx.step_b_runs).toBe(1)
    expect(doneCtx.approved_1).toBe(true)
    expect(doneCtx.approved_2).toBe(true)
    expect(doneCtx.__nf_checkpoint).toBeUndefined()
  })

  it('retries with full replay when persisted checkpoint mismatches', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'runtime-checkpoint-mismatch-fallback'
    const externalTaskId = 'task-runtime-checkpoint-mismatch-fallback-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)
    const canonicalPath = path.join(
      process.cwd(),
      'src',
      'pipe',
      'canonical.ts',
    )

    await writeFile(
      factoryPath,
      `import {ask, definePipe, end, flow} from ${JSON.stringify(canonicalPath)};
export default definePipe({
  id: ${JSON.stringify(factoryId)},
  initial: {approved: false, parsed_count: 0},
  run: flow(
    ask('approve', (ctx, reply) => ({
      ...ctx,
      approved: reply.trim().length > 0,
      parsed_count: Number(ctx.parsed_count ?? 0) + 1,
    })),
    end.done(),
  ),
});
`,
      'utf8',
    )

    await insertQueuedTask({db, schema, timestamp, factoryId, externalTaskId})
    await runtime.runPipeTaskByExternalId(externalTaskId)

    const [paused] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(paused?.state).toBe('needs_input')

    const pausedCtx = JSON.parse(paused?.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >

    await db
      .update(schema.tasks)
      .set({
        state: 'queued',
        stepVarsJson: JSON.stringify({
          ...pausedCtx,
          human_feedback: 'yes',
          __nf_checkpoint: {
            v: 1,
            path: [{k: 'flow', at: 99}],
          },
        }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.tasks.externalTaskId, externalTaskId))

    await runtime.runPipeTaskByExternalId(externalTaskId)

    const [doneTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(doneTask?.state).toBe('done')

    const doneCtx = JSON.parse(doneTask?.stepVarsJson ?? '{}') as Record<
      string,
      unknown
    >
    expect(doneCtx.approved).toBe(true)
    expect(doneCtx.parsed_count).toBe(1)
  })

  it('maps terminal end signals to persisted task and run statuses', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const terminalStates = ['done', 'blocked', 'failed'] as const

    for (const terminalState of terminalStates) {
      const expectedLifecycle =
        terminalState === 'blocked' ? 'needs_input' : terminalState
      const factoryId = `runtime-terminal-${terminalState}`
      const externalTaskId = `task-terminal-${terminalState}`
      const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)

      await writeFile(
        factoryPath,
        `export default {\n` +
          `  id: "${factoryId}",\n` +
          `  initial: {},\n` +
          `  run: async ({ ctx }) => {\n` +
          `    const controlBrand = Symbol.for("pipes.control");\n` +
          `    return {\n` +
          `      [controlBrand]: true,\n` +
          `      type: "end",\n` +
          `      status: "${terminalState}",\n` +
          `      ctx,\n` +
          `      message: "terminal ${terminalState}",\n` +
          `    };\n` +
          `  },\n` +
          `};\n`,
        'utf8',
      )

      await insertQueuedTask({db, schema, timestamp, factoryId, externalTaskId})
      await runtime.runPipeTaskByExternalId(externalTaskId)

      const [updatedTask] = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.externalTaskId, externalTaskId))
      expect(updatedTask).toBeTruthy()
      expect(updatedTask?.state).toBe(expectedLifecycle)

      const [run] = await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.taskId, updatedTask!.id))
      expect(run?.status).toBe(expectedLifecycle)
      expect(run?.currentStateId).toBeNull()
      expect(run?.endedAt).toBeTruthy()
    }
  })

  it('fails run when pipe returns non-object context', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'runtime-invalid-pipe-context'
    const externalTaskId = 'task-invalid-pipe-context-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)

    await writeFile(
      factoryPath,
      `export default {\n` +
        `  id: "${factoryId}",\n` +
        `  initial: {},\n` +
        `  run: async () => "invalid-context",\n` +
        `};\n`,
      'utf8',
    )

    await insertQueuedTask({db, schema, timestamp, factoryId, externalTaskId})
    await expect(
      runtime.runPipeTaskByExternalId(externalTaskId),
    ).rejects.toThrow(/Pipe execution failed/)

    const [updatedTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(updatedTask?.state).toBe('failed')
    expect(updatedTask?.lastError).toContain('Pipe execution failed')

    const traces = await db
      .select()
      .from(schema.runTraces)
      .where(eq(schema.runTraces.taskId, updatedTask!.id))
    const traceTypes = traces.map(trace => trace.type)
    expect(traceTypes).toContain('error')
    expect(traceTypes).toContain('completed')
  })

  it('fails run when pipe emits malformed control signal payload', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'runtime-malformed-control-signal'
    const externalTaskId = 'task-malformed-control-signal-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)
    const canonicalPath = path.join(
      process.cwd(),
      'src',
      'pipe',
      'canonical.ts',
    )

    await writeFile(
      factoryPath,
      `import {definePipe} from ${JSON.stringify(canonicalPath)};\n` +
        `export default definePipe({\n` +
        `  id: "${factoryId}",\n` +
        `  initial: {},\n` +
        `  run: async ({ctx}) => {\n` +
        `    const controlBrand = Symbol.for("pipes.control");\n` +
        `    return {\n` +
        `      [controlBrand]: true,\n` +
        `      type: "await_feedback",\n` +
        `      prompt: "   ",\n` +
        `      ctx,\n` +
        `    };\n` +
        `  },\n` +
        `});\n`,
      'utf8',
    )

    await insertQueuedTask({db, schema, timestamp, factoryId, externalTaskId})
    await expect(
      runtime.runPipeTaskByExternalId(externalTaskId),
    ).rejects.toThrow(/malformed await_feedback control signal/)

    const [updatedTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(updatedTask?.state).toBe('failed')
    expect(updatedTask?.lastError).toContain(
      'malformed await_feedback control signal',
    )
  })

  it('fails fast when definePipe run exceeds maxTransitionsPerTick', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'runtime-pipe-transition-budget'
    const externalTaskId = 'task-pipe-transition-budget-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)
    const canonicalPath = path.join(
      process.cwd(),
      'src',
      'pipe',
      'canonical.ts',
    )

    await writeFile(
      factoryPath,
      `import {definePipe, end, flow, step} from ${JSON.stringify(canonicalPath)};\n` +
        `export default definePipe({\n` +
        `  id: "${factoryId}",\n` +
        `  initial: {count: 0},\n` +
        `  run: flow(\n` +
        `    step("first", ctx => ({...ctx, count: Number(ctx.count ?? 0) + 1})),\n` +
        `    step("second", ctx => ({...ctx, count: Number(ctx.count ?? 0) + 1})),\n` +
        `    end.done(),\n` +
        `  ),\n` +
        `});\n`,
      'utf8',
    )

    await insertQueuedTask({db, schema, timestamp, factoryId, externalTaskId})
    await expect(
      runtime.runPipeTaskByExternalId(externalTaskId, {
        maxTransitionsPerTick: 1,
      }),
    ).rejects.toThrow(/Pipe transition budget exceeded \(1\)/)

    const [updatedTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(updatedTask?.state).toBe('failed')
    expect(updatedTask?.lastError).toContain(
      'Pipe transition budget exceeded (1)',
    )
  })

  it('refuses to run quarantined ownership-mismatch tasks', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'runtime-quarantined-task'
    const externalTaskId = 'task-runtime-quarantined-task-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)

    await writeFile(
      factoryPath,
      `export default {
  id: "${factoryId}",
  initial: {},
  run: async ({ ctx }) => ({ ...ctx, ok: true }),
};
`,
      'utf8',
    )

    await insertQueuedTask({db, schema, timestamp, factoryId, externalTaskId})
    await db
      .update(schema.tasks)
      .set({
        state: 'needs_input',
        lastError: 'pipe_mismatch: local=alpha remote=beta task=page-1',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.tasks.externalTaskId, externalTaskId))

    await expect(
      runtime.runPipeTaskByExternalId(externalTaskId),
    ).rejects.toThrow(/repair-task --task task-runtime-quarantined-task-1/)
  })

  it('keeps lease heartbeats active during long definePipe execution', async () => {
    const {db, paths, runtime, schema, timestamp} = await setupRuntime()
    const factoryId = 'runtime-lease-heartbeat-pipe'
    const externalTaskId = 'task-lease-heartbeat-pipe-1'
    const factoryPath = path.join(paths.workflowsDir, `${factoryId}.mjs`)
    const canonicalPath = path.join(
      process.cwd(),
      'src',
      'pipe',
      'canonical.ts',
    )

    await writeFile(
      factoryPath,
      `import {definePipe, end, flow, step} from ${JSON.stringify(canonicalPath)};\n` +
        `const wait = ms => new Promise(resolve => setTimeout(resolve, ms));\n` +
        `export default definePipe({\n` +
        `  id: "${factoryId}",\n` +
        `  initial: {finished: false},\n` +
        `  run: flow(\n` +
        `    step("long-step", async ctx => {\n` +
        `      await wait(2200);\n` +
        `      return {...ctx, finished: true};\n` +
        `    }),\n` +
        `    end.done(),\n` +
        `  ),\n` +
        `});\n`,
      'utf8',
    )

    await insertQueuedTask({db, schema, timestamp, factoryId, externalTaskId})

    const firstRun = runtime.runPipeTaskByExternalId(externalTaskId, {
      leaseMs: 1_000,
      leaseMode: 'strict',
      workerId: 'worker-a',
    })

    await sleep(1_300)

    await expect(
      runtime.runPipeTaskByExternalId(externalTaskId, {
        leaseMs: 1_000,
        leaseMode: 'strict',
        workerId: 'worker-b',
      }),
    ).rejects.toThrow(/currently leased by another worker/)

    await firstRun

    const [updatedTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.externalTaskId, externalTaskId))
    expect(updatedTask?.state).toBe('done')
  }, 12_000)
})

async function initGitRepo(repoRoot: string): Promise<void> {
  await runGit(['init'], repoRoot)
  await runGit(['config', 'user.name', 'Pipes Test'], repoRoot)
  await runGit(['config', 'user.email', 'pipes@example.com'], repoRoot)
}

async function commitAll(repoRoot: string, message: string): Promise<string> {
  await runGit(['add', '.'], repoRoot)
  await runGit(['commit', '-m', message], repoRoot)
  return runGit(['rev-parse', '--verify', 'HEAD'], repoRoot)
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {cwd, encoding: 'utf8'}, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message))
        return
      }

      resolve(stdout.trim())
    })
  })
}
