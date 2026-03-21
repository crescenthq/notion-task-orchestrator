import {access} from 'node:fs/promises'
import path from 'node:path'
import {and, eq, isNull, lte, or} from 'drizzle-orm'
import {createNotionTaskBoardAdapter} from '../adapters/notion'
import {nowIso, openApp} from '../app/context'
import {notionToken} from '../config/env'
import {boards, runs, runTraces, tasks} from '../db/schema'
import {
  type Checkpoint,
  CheckpointMismatchError,
  parseCheckpoint,
} from '../pipe/checkpoint'
import {brandControlSignal, hasControlSignalBrand} from '../pipe/controlSignal'
import {
  type ResolvedProjectConfig,
  resolveProjectConfig,
} from '../project/discoverConfig'
import {
  loadDeclaredPipes,
  loadProjectConfig,
  resolveWorkspaceConfig,
} from '../project/projectConfig'
import {formatStatusLabel} from '../services/statusIcons'
import {loadPipeFromPath, type PipeModuleDefinition} from './pipe'
import {parseRunTrace, type RunTraceReasonCode} from './runTraces'
import {
  type BoardTaskRef,
  nullTaskBoardAdapter,
  type TaskBoardAdapter,
  type TaskBoardState,
} from './taskBoardAdapter'
import {provisionRunWorkspace} from './workspaceRuntime'

type JsonObject = Record<string, unknown>

type PageContent = {markdown: string; body?: string} | string

type LeaseMode = 'strict' | 'best-effort'

export type RuntimeRunOptions = {
  maxTransitionsPerTick?: number
  leaseMs?: number
  leaseMode?: LeaseMode
  workerId?: string
  configPath?: string
  startDir?: string
  taskBoardAdapter?: TaskBoardAdapter
}

type NormalizedRuntimeRunOptions = {
  maxTransitionsPerTick: number
  leaseMs: number
  leaseMode: LeaseMode
  workerId: string
}

const MAX_TRANSITIONS_PER_RUN = 200
const DEFAULT_MAX_TRANSITIONS_PER_TICK = 25
const DEFAULT_LEASE_MS = 30_000
const PIPE_RUNNING_STATE_ID = '__pipe_run__'
const PIPE_FEEDBACK_STATE_ID = '__pipe_feedback__'
const PIPE_DONE_STATE_ID = '__pipe_done__'
const PIPE_BLOCKED_STATE_ID = '__pipe_blocked__'
const PIPE_FAILED_STATE_ID = '__pipe_failed__'
const PIPE_FEEDBACK_PROMPT_KEY = '__nf_feedback_prompt'
const PIPE_CHECKPOINT_KEY = '__nf_checkpoint'
const OWNERSHIP_QUARANTINE_PREFIXES = ['pipe_mismatch:', 'pipe_invalid:']

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isPipeControlSignalType(
  value: unknown,
): value is JsonObject & {type: 'await_feedback' | 'end'} {
  return (
    isRecord(value) && (value.type === 'await_feedback' || value.type === 'end')
  )
}

function coercePipeControlSignal(value: unknown): unknown {
  if (!isPipeControlSignalType(value) || hasControlSignalBrand(value)) {
    return value
  }
  return brandControlSignal({...value})
}

function omitCheckpointContextKey(ctx: JsonObject): JsonObject {
  if (!(PIPE_CHECKPOINT_KEY in ctx)) return ctx
  const next = {...ctx}
  delete next[PIPE_CHECKPOINT_KEY]
  return next
}

function isCheckpointMismatchError(error: unknown): boolean {
  return (
    error instanceof CheckpointMismatchError ||
    (isRecord(error) && error.code === 'checkpoint_mismatch')
  )
}

function isOwnershipQuarantined(lastError: string | null | undefined): boolean {
  return OWNERSHIP_QUARANTINE_PREFIXES.some(prefix =>
    lastError?.startsWith(prefix),
  )
}

type PipeAwaitFeedbackSignal = {
  type: 'await_feedback'
  prompt: string
  ctx: unknown
  checkpoint?: unknown
}

type PipeEndSignal = {
  type: 'end'
  status: 'done' | 'blocked' | 'failed'
  ctx: unknown
  message?: string
}

type PipeStepLifecycleEvent = {
  name: string
  kind: string
  ctx: unknown
}

function isPipeAwaitFeedbackSignal(
  value: unknown,
): value is PipeAwaitFeedbackSignal {
  return (
    isRecord(value) &&
    hasControlSignalBrand(value) &&
    value.type === 'await_feedback' &&
    typeof value.prompt === 'string' &&
    value.prompt.trim().length > 0 &&
    'ctx' in value
  )
}

function isPipeEndSignal(value: unknown): value is PipeEndSignal {
  return (
    isRecord(value) &&
    hasControlSignalBrand(value) &&
    value.type === 'end' &&
    (value.status === 'done' ||
      value.status === 'blocked' ||
      value.status === 'failed') &&
    'ctx' in value &&
    (value.message === undefined || typeof value.message === 'string')
  )
}

function isMalformedPipeControlSignal(value: unknown): value is JsonObject {
  if (!isPipeControlSignalType(value) || !hasControlSignalBrand(value)) {
    return false
  }
  return !isPipeAwaitFeedbackSignal(value) && !isPipeEndSignal(value)
}

function normalizeStepLabel(stepName: string): string {
  const trimmed = stepName.trim()
  if (trimmed.length === 0) return ''

  const formatted = formatStatusLabel(trimmed)
  const label = formatted.length > 0 ? formatted : trimmed
  return label.slice(0, 100)
}

function mergeContext(base: JsonObject, patch?: JsonObject): JsonObject {
  return patch ? {...base, ...patch} : base
}

function normalizeRuntimeRunOptions(
  options: RuntimeRunOptions | undefined,
): NormalizedRuntimeRunOptions {
  const maxTransitionsPerTick = Math.max(
    1,
    Math.min(
      MAX_TRANSITIONS_PER_RUN,
      Math.floor(
        options?.maxTransitionsPerTick ?? DEFAULT_MAX_TRANSITIONS_PER_TICK,
      ),
    ),
  )
  const leaseMs = Math.max(
    1_000,
    Math.floor(options?.leaseMs ?? DEFAULT_LEASE_MS),
  )
  const leaseMode: LeaseMode =
    options?.leaseMode === 'best-effort' ? 'best-effort' : 'strict'
  const workerId =
    options?.workerId && options.workerId.trim().length > 0
      ? options.workerId
      : `worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`
  return {maxTransitionsPerTick, leaseMs, leaseMode, workerId}
}

function resolveRuntimeStartDir(options: RuntimeRunOptions): string {
  if (options.startDir !== undefined) {
    return options.startDir
  }

  const projectRootOverride = process.env.NOTIONFLOW_PROJECT_ROOT?.trim()
  return projectRootOverride && projectRootOverride.length > 0
    ? projectRootOverride
    : process.cwd()
}

async function provisionRuntimeWorkspace(options: {
  paths: Awaited<ReturnType<typeof openApp>>['paths']
  projectConfig: ResolvedProjectConfig | null
  runId: string
  resume: boolean
}): Promise<void> {
  if (!options.projectConfig) return

  const config = await loadProjectConfig(options.projectConfig.configPath)
  const workspace = await resolveWorkspaceConfig({
    config,
    projectRoot: options.projectConfig.projectRoot,
    configPath: options.projectConfig.configPath,
  })

  await provisionRunWorkspace({
    paths: options.paths,
    projectRoot: options.projectConfig.projectRoot,
    workspace,
    runId: options.runId,
    resume: options.resume,
  })
}

function selectMostRecentOpenRun<T extends {updatedAt: string; createdAt: string}>(
  openRuns: T[],
): T | undefined {
  return [...openRuns]
    .sort((left, right) => {
      const updatedAtComparison = left.updatedAt.localeCompare(right.updatedAt)
      if (updatedAtComparison !== 0) return updatedAtComparison
      return left.createdAt.localeCompare(right.createdAt)
    })
    .at(-1)
}

function leaseExpiryIso(leaseMs: number): string {
  return new Date(Date.now() + leaseMs).toISOString()
}

async function resolveInstalledPipePath(
  pipeId: string,
  workflowsDir: string,
): Promise<string> {
  const candidates = ['.ts', '.mts', '.js', '.mjs', '.cts', '.cjs'].map(ext =>
    path.join(workflowsDir, `${pipeId}${ext}`),
  )
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // keep searching
    }
  }
  throw new Error(
    `Pipe module not found for \`${pipeId}\`. Expected one of: ${candidates.join(', ')}`,
  )
}

async function resolvePipePathById(options: {
  pipeId: string
  projectConfig: ResolvedProjectConfig | null
  workflowsDir: string
}): Promise<string> {
  if (options.projectConfig) {
    const declaredPipes = await loadDeclaredPipes({
      configPath: options.projectConfig.configPath,
      projectRoot: options.projectConfig.projectRoot,
    })
    if (declaredPipes.length > 0) {
      const declaredPipe = declaredPipes.find(
        entry => entry.definition.id === options.pipeId,
      )
      if (declaredPipe) {
        return declaredPipe.resolvedPath
      }

      const availablePipeIds = declaredPipes
        .map(entry => entry.definition.id)
        .sort()
      throw new Error(
        [
          `Pipe \`${options.pipeId}\` is not declared in project config.`,
          `Config path: ${options.projectConfig.configPath}`,
          `Available pipes: ${availablePipeIds.join(', ') || '<none>'}`,
        ].join('\n'),
      )
    }
  }

  return resolveInstalledPipePath(options.pipeId, options.workflowsDir)
}

function getTaskSelector(task: {boardId: string; externalTaskId: string}) {
  return and(
    eq(tasks.boardId, task.boardId),
    eq(tasks.externalTaskId, task.externalTaskId),
  )
}

export async function runPipeTaskByExternalId(
  taskExternalId: string,
  options: RuntimeRunOptions = {},
): Promise<void> {
  const runtimeOptions = normalizeRuntimeRunOptions(options)
  const startDir = resolveRuntimeStartDir(options)
  const {db, paths} = await openApp({
    startDir,
    configPath: options.configPath,
  })
  const resolvedProjectConfig = await resolveProjectConfig({
    startDir,
    configPath: options.configPath,
  }).catch(() => null)
  const [task] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.externalTaskId, taskExternalId))
  if (!task) throw new Error(`Task not found: ${taskExternalId}`)
  if (isOwnershipQuarantined(task.lastError)) {
    throw new Error(
      [
        `Task ${task.externalTaskId} is quarantined and cannot run until its shared-board Pipe mismatch is resolved: ${task.lastError}`,
        `Restore the original Pipe in Notion, then run \`notionflow integrations notion repair-task --task ${task.externalTaskId}\` to re-queue it safely.`,
      ].join(' '),
    )
  }

  const [board] = await db
    .select()
    .from(boards)
    .where(eq(boards.id, task.boardId))
  const token = notionToken()
  const taskRef: BoardTaskRef = {
    boardId: task.boardId,
    externalTaskId: task.externalTaskId,
  }

  if (!options.taskBoardAdapter && board?.adapter === 'notion' && !token) {
    console.log(
      '[warn] NOTION_API_TOKEN missing; using null task board adapter',
    )
  }

  const boardAdapter =
    options.taskBoardAdapter ??
    (board?.adapter === 'notion' && token
      ? createNotionTaskBoardAdapter(token)
      : nullTaskBoardAdapter)

  const syncBoardState = async (
    state: TaskBoardState,
    stateLabel?: string,
  ): Promise<void> => {
    try {
      await boardAdapter.updateState(taskRef, {state, label: stateLabel})
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(
        `[warn] failed to sync board task state (${boardAdapter.kind}): ${message}`,
      )
    }
  }

  const syncBoardLog = async (
    title: string,
    detail?: string,
  ): Promise<void> => {
    try {
      await boardAdapter.appendLog(taskRef, title, detail)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(
        `[warn] failed to append board task log (${boardAdapter.kind}): ${message}`,
      )
    }
  }

  const pipePath = await resolvePipePathById({
    pipeId: task.workflowId,
    projectConfig: resolvedProjectConfig,
    workflowsDir: paths.workflowsDir,
  })
  const {definition} = await loadPipeFromPath(pipePath)
  const pipeDefinition: PipeModuleDefinition = definition

  let taskTitle = task.externalTaskId
  let taskContext = ''
  try {
    const snapshot = await boardAdapter.getTask(taskRef)
    if (snapshot.title.trim().length > 0) {
      taskTitle = snapshot.title
    }
    taskContext = snapshot.bodyText
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(
      `[warn] failed to load board task snapshot (${boardAdapter.kind}): ${message}`,
    )
  }

  const promptLine = taskContext
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length > 0)
  const taskPrompt = promptLine ?? taskTitle

  if (!isRecord(pipeDefinition.initial)) {
    throw new Error(
      `Pipe \`${definition.id}\` must define an object context for runtime persistence`,
    )
  }

  const defaultContext: JsonObject = pipeDefinition.initial
  const initialStateId: string = PIPE_RUNNING_STATE_ID

  let ctx: JsonObject = {
    ...defaultContext,
    task_id: task.externalTaskId,
    task_title: taskTitle,
    task_prompt: taskPrompt,
    task_context: taskContext,
  }

  if (task.stepVarsJson) {
    try {
      const persisted = JSON.parse(task.stepVarsJson)
      if (isRecord(persisted)) ctx = mergeContext(ctx, persisted)
    } catch {
      console.log(
        '[warn] failed to parse persisted pipe context; using defaults',
      )
    }
  }

  const persistedCheckpointValue = ctx[PIPE_CHECKPOINT_KEY]
  const persistedCheckpoint = parseCheckpoint(persistedCheckpointValue, {
    location: 'persisted context',
    onInvalid: 'return-undefined',
  })
  if (
    persistedCheckpointValue !== undefined &&
    persistedCheckpointValue !== null &&
    !persistedCheckpoint
  ) {
    console.log(
      '[warn] invalid persisted checkpoint; falling back to full replay',
    )
  }
  ctx = omitCheckpointContextKey(ctx)

  let currentStateId = task.currentStepId ? task.currentStepId : initialStateId
  const resumed = task.currentStepId !== null || task.stepVarsJson !== null

  const openRuns = await db
    .select()
    .from(runs)
    .where(and(eq(runs.taskId, task.id), isNull(runs.endedAt)))
  const activeRun = selectMostRecentOpenRun(openRuns)
  const runId = activeRun?.id ?? crypto.randomUUID()
  const now = nowIso()
  if (!activeRun) {
    await db.insert(runs).values({
      id: runId,
      taskId: task.id,
      status: 'running',
      currentStateId,
      contextJson: JSON.stringify(ctx),
      leaseOwner: null,
      leaseExpiresAt: null,
      leaseHeartbeatAt: null,
      startedAt: now,
      endedAt: null,
      createdAt: now,
      updatedAt: now,
    })
  } else {
    await db
      .update(runs)
      .set({
        status: 'running',
        currentStateId,
        contextJson: JSON.stringify(ctx),
        updatedAt: now,
      })
      .where(eq(runs.id, runId))
  }

  const tickId = crypto.randomUUID()
  const leaseOwner = runtimeOptions.workerId

  const acquireRunLease = async (): Promise<boolean> => {
    const leaseAcquiredAt = nowIso()
    const result = await db
      .update(runs)
      .set({
        leaseOwner,
        leaseExpiresAt: leaseExpiryIso(runtimeOptions.leaseMs),
        leaseHeartbeatAt: leaseAcquiredAt,
        updatedAt: leaseAcquiredAt,
      })
      .where(
        and(
          eq(runs.id, runId),
          or(
            isNull(runs.leaseExpiresAt),
            lte(runs.leaseExpiresAt, leaseAcquiredAt),
            eq(runs.leaseOwner, leaseOwner),
          ),
        ),
      )
    return Number((result as {rowsAffected?: number}).rowsAffected ?? 0) > 0
  }

  const renewRunLease = async (): Promise<void> => {
    const heartbeatAt = nowIso()
    const result = await db
      .update(runs)
      .set({
        leaseExpiresAt: leaseExpiryIso(runtimeOptions.leaseMs),
        leaseHeartbeatAt: heartbeatAt,
        updatedAt: heartbeatAt,
      })
      .where(and(eq(runs.id, runId), eq(runs.leaseOwner, leaseOwner)))
    const heartbeatUpdated =
      Number((result as {rowsAffected?: number}).rowsAffected ?? 0) > 0
    if (!heartbeatUpdated) {
      throw new Error(`Run lease lost for task ${task.externalTaskId}`)
    }
  }

  const acquiredLease = await acquireRunLease()
  if (!acquiredLease) {
    const message = `Run ${runId} is currently leased by another worker`
    if (runtimeOptions.leaseMode === 'best-effort') {
      console.log(`[lease] ${message}; skipping task ${task.externalTaskId}`)
      return
    }
    throw new Error(message)
  }

  let pipeStepTransitions = 0
  let activeStepLabel: string | undefined
  let leaseRenewalError: Error | null = null
  let leaseHeartbeatTimer: NodeJS.Timeout | null = null
  let leaseHeartbeatInFlight: Promise<void> | null = null

  const asError = (error: unknown): Error =>
    error instanceof Error ? error : new Error(String(error))

  const renewRunLeaseSafely = async (): Promise<void> => {
    if (leaseRenewalError) return

    if (leaseHeartbeatInFlight) {
      await leaseHeartbeatInFlight
      return
    }

    leaseHeartbeatInFlight = renewRunLease()
      .catch(error => {
        leaseRenewalError = asError(error)
      })
      .finally(() => {
        leaseHeartbeatInFlight = null
      })

    await leaseHeartbeatInFlight
  }

  const ensureActiveLease = async (): Promise<void> => {
    if (leaseRenewalError) throw leaseRenewalError
    await renewRunLeaseSafely()
    if (leaseRenewalError) throw leaseRenewalError
  }

  const startLeaseHeartbeat = (): void => {
    const intervalMs = Math.max(1_000, Math.floor(runtimeOptions.leaseMs / 3))
    leaseHeartbeatTimer = setInterval(() => {
      void renewRunLeaseSafely()
    }, intervalMs)
    leaseHeartbeatTimer.unref?.()
  }

  const stopLeaseHeartbeat = async (): Promise<void> => {
    if (leaseHeartbeatTimer) {
      clearInterval(leaseHeartbeatTimer)
      leaseHeartbeatTimer = null
    }
    if (leaseHeartbeatInFlight) {
      await leaseHeartbeatInFlight
    }
    if (leaseRenewalError) {
      throw leaseRenewalError
    }
  }

  const onPipeStepStart = async (
    event: PipeStepLifecycleEvent,
  ): Promise<void> => {
    if (leaseRenewalError) {
      throw leaseRenewalError
    }

    pipeStepTransitions += 1
    if (pipeStepTransitions > runtimeOptions.maxTransitionsPerTick) {
      throw new Error(
        [
          `Pipe transition budget exceeded (${runtimeOptions.maxTransitionsPerTick}) for task ${task.externalTaskId}.`,
          'Increase --max-transitions-per-tick or split work across ticks.',
        ].join(' '),
      )
    }

    const rawStepName =
      event.name.trim().length > 0 ? event.name : event.kind.trim()
    const stepLabel = normalizeStepLabel(rawStepName)
    if (!stepLabel || stepLabel === activeStepLabel) return

    activeStepLabel = stepLabel
    await syncBoardState('running', stepLabel)
  }

  const finalizeRun = async (
    status: 'done' | 'blocked' | 'failed',
  ): Promise<void> => {
    const timestamp = nowIso()
    const isDone = status === 'done'
    await db
      .update(tasks)
      .set({
        state: status,
        currentStepId: null,
        stepVarsJson: JSON.stringify(ctx),
        waitingSince: null,
        updatedAt: timestamp,
        lastError: isDone
          ? null
          : String(ctx.last_error ?? `Terminal state: ${status}`),
      })
      .where(getTaskSelector(task))
    await db
      .update(runs)
      .set({
        status,
        currentStateId: null,
        contextJson: JSON.stringify(ctx),
        leaseOwner: null,
        leaseExpiresAt: null,
        leaseHeartbeatAt: null,
        endedAt: timestamp,
        updatedAt: timestamp,
      })
      .where(eq(runs.id, runId))
    await persistRunTrace({
      type: 'completed',
      stateId: currentStateId,
      status,
      message:
        status === 'done'
          ? 'Pipe reached terminal done state.'
          : String(ctx.last_error ?? 'no detail'),
    })
    await syncBoardState(status)
    await syncBoardLog(
      status === 'done' ? 'Task complete' : `Task ${status}`,
      status === 'done'
        ? 'Pipe reached terminal done state.'
        : String(ctx.last_error ?? 'no detail'),
    )
  }

  const failRun = async (message: string): Promise<never> => {
    const timestamp = nowIso()
    ctx = mergeContext(ctx, {last_error: message})
    await db
      .update(tasks)
      .set({
        state: 'failed',
        currentStepId: currentStateId,
        stepVarsJson: JSON.stringify(ctx),
        updatedAt: timestamp,
        lastError: message,
      })
      .where(getTaskSelector(task))
    await db
      .update(runs)
      .set({
        status: 'failed',
        currentStateId,
        contextJson: JSON.stringify(ctx),
        leaseOwner: null,
        leaseExpiresAt: null,
        leaseHeartbeatAt: null,
        endedAt: timestamp,
        updatedAt: timestamp,
      })
      .where(eq(runs.id, runId))
    await persistRunTrace({
      type: 'error',
      stateId: currentStateId,
      status: 'failed',
      message,
    })
    await persistRunTrace({
      type: 'completed',
      stateId: currentStateId,
      status: 'failed',
      message,
    })
    await syncBoardState('failed')
    await syncBoardLog('Task failed', message)
    throw new Error(message)
  }

  const persistRunTrace = async (trace: {
    type:
      | 'started'
      | 'resumed'
      | 'step'
      | 'retry'
      | 'await_feedback'
      | 'write'
      | 'completed'
      | 'error'
    stateId?: string | null
    fromStateId?: string | null
    toStateId?: string | null
    event?: string | null
    reason?: RunTraceReasonCode | null
    attempt?: number
    loopIteration?: number
    status?: 'running' | 'feedback' | 'done' | 'blocked' | 'failed' | null
    message?: string | null
    payload?: unknown
  }): Promise<void> => {
    const record = parseRunTrace({
      id: crypto.randomUUID(),
      runId,
      tickId,
      taskId: task.id,
      type: trace.type,
      stateId: trace.stateId ?? null,
      fromStateId: trace.fromStateId ?? null,
      toStateId: trace.toStateId ?? null,
      event: trace.event ?? null,
      reason: trace.reason ?? null,
      attempt: Math.max(0, Math.floor(trace.attempt ?? 0)),
      loopIteration: Math.max(0, Math.floor(trace.loopIteration ?? 0)),
      status: trace.status ?? null,
      message: trace.message ?? null,
      payloadJson:
        trace.payload === undefined ? null : JSON.stringify(trace.payload),
      timestamp: nowIso(),
    })
    await db.insert(runTraces).values(record)
  }

  const persistStepTrace = async (
    fromStateId: string,
    toStateId: string,
    event: string,
    reason: RunTraceReasonCode,
    attempt: number,
    loopIteration: number,
  ): Promise<void> => {
    await persistRunTrace({
      type: 'step',
      fromStateId,
      toStateId,
      event,
      reason,
      attempt,
      loopIteration,
      stateId: toStateId,
    })
  }

  await db
    .update(tasks)
    .set({
      state: 'running',
      currentStepId: currentStateId,
      stepVarsJson: JSON.stringify(ctx),
      updatedAt: nowIso(),
      lastError: null,
      waitingSince: null,
    })
    .where(getTaskSelector(task))
  await db
    .update(runs)
    .set({
      status: 'running',
      currentStateId,
      contextJson: JSON.stringify(ctx),
      updatedAt: nowIso(),
    })
    .where(eq(runs.id, runId))
  await syncBoardState('running')
  await syncBoardLog(
    resumed ? `Resuming from state ${currentStateId}` : 'Run started',
    `Pipe: ${definition.id}`,
  )
  await persistRunTrace({
    type: 'started',
    stateId: currentStateId,
    status: 'running',
    message: `Pipe: ${definition.id}`,
  })
  if (resumed) {
    await persistRunTrace({
      type: 'resumed',
      stateId: currentStateId,
      message: 'Resumed with persisted state/context',
    })
  }

  const writePage = async (output: PageContent): Promise<void> => {
    const markdown = typeof output === 'string' ? output : output.markdown
    if (!markdown || markdown.trim().length === 0) return
    await persistRunTrace({
      type: 'write',
      stateId: currentStateId,
      message: 'Pipe emitted page output',
      payload: {
        markdownLength: markdown.length,
        format: typeof output === 'string' ? 'string' : 'markdown',
      },
    })
    try {
      await boardAdapter.appendPageContent(taskRef, markdown)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(
        `[warn] failed to append board page content (${boardAdapter.kind}): ${message}`,
      )
    }
  }

  const parsePipeContext = (value: unknown, label: string): JsonObject => {
    if (!isRecord(value)) {
      throw new Error(
        `Pipe \`${definition.id}\` emitted non-object context for ${label}`,
      )
    }
    return value
  }

  try {
    const feedback =
      typeof ctx.human_feedback === 'string' && ctx.human_feedback.trim()
        ? ctx.human_feedback.trim()
        : undefined

    await ensureActiveLease()
    startLeaseHeartbeat()

    let result: unknown
    try {
      await provisionRuntimeWorkspace({
        paths,
        projectConfig: resolvedProjectConfig,
        runId,
        resume: resumed,
      })

      const runPipe = async (
        checkpoint: Checkpoint | undefined,
      ): Promise<unknown> =>
        pipeDefinition.run({
          ctx,
          feedback,
          checkpoint,
          task: {
            id: task.externalTaskId,
            title: taskTitle,
            prompt: taskPrompt,
            context: taskContext,
          },
          writePage,
          onStepStart: onPipeStepStart,
          runId,
          tickId,
        })

      let activeCheckpoint = persistedCheckpoint
      try {
        result = await runPipe(activeCheckpoint)
      } catch (error) {
        if (activeCheckpoint && isCheckpointMismatchError(error)) {
          console.log(
            '[warn] checkpoint mismatch during resume; retrying with full replay',
          )
          activeCheckpoint = undefined
          result = await runPipe(undefined)
        } else {
          throw error
        }
      }
    } finally {
      await stopLeaseHeartbeat()
    }

    await ensureActiveLease()
    result = coercePipeControlSignal(result)

    if (isPipeAwaitFeedbackSignal(result)) {
      const signalCheckpoint = parseCheckpoint(result.checkpoint, {
        location: 'await_feedback signal',
      })
      ctx = mergeContext(
        omitCheckpointContextKey(
          parsePipeContext(result.ctx, 'await_feedback'),
        ),
        {
          [PIPE_FEEDBACK_PROMPT_KEY]: result.prompt,
          [PIPE_CHECKPOINT_KEY]: signalCheckpoint ?? null,
        },
      )
      await persistStepTrace(
        currentStateId,
        PIPE_FEEDBACK_STATE_ID,
        'feedback',
        'action.feedback',
        1,
        0,
      )
      currentStateId = PIPE_FEEDBACK_STATE_ID
      await persistRunTrace({
        type: 'await_feedback',
        stateId: currentStateId,
        message: result.prompt,
      })

      try {
        await boardAdapter.postComment(taskRef, result.prompt)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.log(
          `[warn] failed to post board comment (${boardAdapter.kind}): ${message}`,
        )
      }

      await db
        .update(tasks)
        .set({
          state: 'feedback',
          currentStepId: currentStateId,
          stepVarsJson: JSON.stringify(ctx),
          waitingSince: nowIso(),
          updatedAt: nowIso(),
          lastError: null,
        })
        .where(getTaskSelector(task))
      await db
        .update(runs)
        .set({
          status: 'feedback',
          currentStateId,
          contextJson: JSON.stringify(ctx),
          leaseOwner: null,
          leaseExpiresAt: null,
          leaseHeartbeatAt: null,
          updatedAt: nowIso(),
        })
        .where(eq(runs.id, runId))
      await syncBoardState('feedback')
      await syncBoardLog(`Feedback needed: ${currentStateId}`, result.prompt)
      return
    }

    if (isPipeEndSignal(result)) {
      ctx = omitCheckpointContextKey(
        parsePipeContext(result.ctx, `end.${result.status}`),
      )
      if (result.message) {
        ctx = mergeContext(ctx, {last_error: result.message})
      }

      const transitionMeta: {
        toStateId: string
        event: string
        reason: RunTraceReasonCode
      } =
        result.status === 'done'
          ? {
              toStateId: PIPE_DONE_STATE_ID,
              event: 'done',
              reason: 'action.done',
            }
          : result.status === 'blocked'
            ? {
                toStateId: PIPE_BLOCKED_STATE_ID,
                event: 'blocked',
                reason: 'orchestrate.agent',
              }
            : {
                toStateId: PIPE_FAILED_STATE_ID,
                event: 'failed',
                reason: 'action.failed.exhausted',
              }

      await persistStepTrace(
        currentStateId,
        transitionMeta.toStateId,
        transitionMeta.event,
        transitionMeta.reason,
        1,
        0,
      )
      currentStateId = transitionMeta.toStateId
      await finalizeRun(result.status)
      console.log(`Task run complete: ${result.status}`)
      return
    }

    if (isMalformedPipeControlSignal(result)) {
      throw new Error(
        `Pipe \`${definition.id}\` emitted malformed ${String(result.type)} control signal`,
      )
    }

    ctx = omitCheckpointContextKey(parsePipeContext(result, 'run'))
    await persistStepTrace(
      currentStateId,
      PIPE_DONE_STATE_ID,
      'done',
      'action.done',
      1,
      0,
    )
    currentStateId = PIPE_DONE_STATE_ID
    await finalizeRun('done')
    console.log('Task run complete: done')
    return
  } catch (error) {
    if (leaseHeartbeatTimer) {
      clearInterval(leaseHeartbeatTimer)
      leaseHeartbeatTimer = null
    }
    const message = error instanceof Error ? error.message : String(error)
    await failRun(`Pipe execution failed: ${message}`)
  }
}
