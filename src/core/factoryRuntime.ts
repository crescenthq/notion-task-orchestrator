import {access} from 'node:fs/promises'
import path from 'node:path'
import {and, eq, isNull, lte, or} from 'drizzle-orm'
import {nowIso, openApp} from '../app/context'
import {notionToken} from '../config/env'
import {loadFactoryFromPath, type PipeFactoryDefinition} from './factory'
import {boards, runTraces, runs, tasks} from '../db/schema'
import {
  resolveProjectConfig,
  type ResolvedProjectConfig,
} from '../project/discoverConfig'
import {loadDeclaredFactories} from '../project/projectConfig'
import {parseRunTrace, RunTraceReasonCode} from './runTraces'
import {
  notionAppendMarkdownToPage,
  notionAppendTaskPageLog,
  notionGetPage,
  notionGetPageBodyText,
  notionPostComment,
  notionUpdateTaskPageState,
  pageTitle,
} from '../services/notion'

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

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

type PipeAwaitFeedbackSignal = {
  type: 'await_feedback'
  prompt: string
  ctx: unknown
}

type PipeEndSignal = {
  type: 'end'
  status: 'done' | 'blocked' | 'failed'
  ctx: unknown
  message?: string
}

function isPipeAwaitFeedbackSignal(
  value: unknown,
): value is PipeAwaitFeedbackSignal {
  return (
    isRecord(value) &&
    value.type === 'await_feedback' &&
    typeof value.prompt === 'string' &&
    value.prompt.trim().length > 0 &&
    'ctx' in value
  )
}

function isPipeEndSignal(value: unknown): value is PipeEndSignal {
  return (
    isRecord(value) &&
    value.type === 'end' &&
    (value.status === 'done' ||
      value.status === 'blocked' ||
      value.status === 'failed') &&
    'ctx' in value &&
    (value.message === undefined || typeof value.message === 'string')
  )
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

function leaseExpiryIso(leaseMs: number): string {
  return new Date(Date.now() + leaseMs).toISOString()
}

async function resolveInstalledFactoryPath(
  factoryId: string,
  workflowsDir: string,
): Promise<string> {
  const candidates = ['.ts', '.mts', '.js', '.mjs', '.cts', '.cjs'].map(ext =>
    path.join(workflowsDir, `${factoryId}${ext}`),
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
    `Factory module not found for \`${factoryId}\`. Expected one of: ${candidates.join(', ')}`,
  )
}

async function resolveFactoryPathById(options: {
  factoryId: string
  projectConfig: ResolvedProjectConfig | null
  workflowsDir: string
}): Promise<string> {
  if (options.projectConfig) {
    const declaredFactories = await loadDeclaredFactories({
      configPath: options.projectConfig.configPath,
      projectRoot: options.projectConfig.projectRoot,
    })
    if (declaredFactories.length > 0) {
      const declaredFactory = declaredFactories.find(
        entry => entry.definition.id === options.factoryId,
      )
      if (declaredFactory) {
        return declaredFactory.resolvedPath
      }

      const availableFactoryIds = declaredFactories
        .map(entry => entry.definition.id)
        .sort()
      throw new Error(
        [
          `Factory \`${options.factoryId}\` is not declared in project config.`,
          `Config path: ${options.projectConfig.configPath}`,
          `Available factories: ${availableFactoryIds.join(', ') || '<none>'}`,
        ].join('\n'),
      )
    }
  }

  return resolveInstalledFactoryPath(options.factoryId, options.workflowsDir)
}

function getTaskSelector(task: {boardId: string; externalTaskId: string}) {
  return and(
    eq(tasks.boardId, task.boardId),
    eq(tasks.externalTaskId, task.externalTaskId),
  )
}

export async function runFactoryTaskByExternalId(
  taskExternalId: string,
  options: RuntimeRunOptions = {},
): Promise<void> {
  const runtimeOptions = normalizeRuntimeRunOptions(options)
  const startDir = options.startDir ?? process.cwd()
  const {db, paths} = await openApp({startDir, configPath: options.configPath})
  const resolvedProjectConfig = await resolveProjectConfig({
    startDir,
    configPath: options.configPath,
  }).catch(() => null)
  const [task] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.externalTaskId, taskExternalId))
  if (!task) throw new Error(`Task not found: ${taskExternalId}`)

  const [board] = await db
    .select()
    .from(boards)
    .where(eq(boards.id, task.boardId))
  const token = notionToken()

  const syncNotionState = async (
    state: string,
    stateLabel?: string,
  ): Promise<void> => {
    if (!board || board.adapter !== 'notion') return
    if (!token) {
      console.log(
        '[warn] skipping Notion task state update (NOTION_API_TOKEN missing)',
      )
      return
    }
    try {
      await notionUpdateTaskPageState(
        token,
        task.externalTaskId,
        state,
        stateLabel,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(`[warn] failed to sync Notion task state: ${message}`)
    }
  }

  const syncNotionLog = async (
    title: string,
    detail?: string,
  ): Promise<void> => {
    if (!board || board.adapter !== 'notion' || !token) return
    try {
      await notionAppendTaskPageLog(token, task.externalTaskId, title, detail)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(`[warn] failed to append Notion page log: ${message}`)
    }
  }

  const factoryPath = await resolveFactoryPathById({
    factoryId: task.workflowId,
    projectConfig: resolvedProjectConfig,
    workflowsDir: paths.workflowsDir,
  })
  const {definition} = await loadFactoryFromPath(factoryPath)
  const pipeDefinition: PipeFactoryDefinition = definition

  let taskTitle = task.externalTaskId
  let taskContext = ''
  if (board?.adapter === 'notion' && token) {
    try {
      const notionPage = await notionGetPage(token, task.externalTaskId)
      taskTitle = pageTitle(notionPage)
      taskContext = await notionGetPageBodyText(token, task.externalTaskId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(
        `[warn] failed to load Notion page content for context: ${message}`,
      )
    }
  }

  const promptLine = taskContext
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length > 0)
  const taskPrompt = promptLine ?? taskTitle

  let defaultContext: JsonObject
  let initialStateId: string
  if (!isRecord(pipeDefinition.initial)) {
    throw new Error(
      `Factory \`${definition.id}\` must define an object context for runtime persistence`,
    )
  }
  defaultContext = pipeDefinition.initial
  initialStateId = PIPE_RUNNING_STATE_ID

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
        '[warn] failed to parse persisted factory context; using defaults',
      )
    }
  }

  let currentStateId = task.currentStepId ? task.currentStepId : initialStateId
  const resumed = task.currentStepId !== null || task.stepVarsJson !== null

  const [activeRun] = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.taskId, task.id),
        isNull(runs.endedAt),
        eq(runs.status, 'running'),
      ),
    )
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
          ? 'Factory reached terminal done state.'
          : String(ctx.last_error ?? 'no detail'),
    })
    await syncNotionState(status)
    await syncNotionLog(
      status === 'done' ? 'Task complete' : `Task ${status}`,
      status === 'done'
        ? 'Factory reached terminal done state.'
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
    await syncNotionState('failed')
    await syncNotionLog('Task failed', message)
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
  await syncNotionState('running')
  await syncNotionLog(
    resumed ? `Resuming from state ${currentStateId}` : 'Run started',
    `Factory: ${definition.id}`,
  )
  await persistRunTrace({
    type: 'started',
    stateId: currentStateId,
    status: 'running',
    message: `Factory: ${definition.id}`,
  })
  if (resumed) {
    await persistRunTrace({
      type: 'resumed',
      stateId: currentStateId,
      message: 'Resumed with persisted state/context',
    })
  }

  await renewRunLease()

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
      if (!board || board.adapter !== 'notion' || !token) return
      try {
        await notionAppendMarkdownToPage(token, task.externalTaskId, markdown)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.log(`[warn] failed to append page content to Notion: ${message}`)
      }
    }

    const parsePipeContext = (
      value: unknown,
      label: string,
    ): JsonObject => {
      if (!isRecord(value)) {
        throw new Error(
          `Pipe factory \`${definition.id}\` emitted non-object context for ${label}`,
        )
      }
      return value
    }

    try {
      const feedback =
        typeof ctx.human_feedback === 'string' && ctx.human_feedback.trim()
          ? ctx.human_feedback.trim()
          : undefined

      const result = await pipeDefinition.run({
        ctx,
        feedback,
        task: {
          id: task.externalTaskId,
          title: taskTitle,
          prompt: taskPrompt,
          context: taskContext,
        },
        writePage,
        runId,
        tickId,
      })

      if (isPipeAwaitFeedbackSignal(result)) {
        ctx = mergeContext(parsePipeContext(result.ctx, 'await_feedback'), {
          [PIPE_FEEDBACK_PROMPT_KEY]: result.prompt,
        })
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

        if (token && board?.adapter === 'notion') {
          try {
            await notionPostComment(token, task.externalTaskId, result.prompt)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.log(`[warn] failed to post Notion comment: ${message}`)
          }
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
        await syncNotionState('feedback')
        await syncNotionLog(`Feedback needed: ${currentStateId}`, result.prompt)
        return
      }

      if (isPipeEndSignal(result)) {
        ctx = parsePipeContext(result.ctx, `end.${result.status}`)
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

      ctx = parsePipeContext(result, 'run')
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
      const message = error instanceof Error ? error.message : String(error)
      await failRun(`Pipe execution failed: ${message}`)
    }
}
