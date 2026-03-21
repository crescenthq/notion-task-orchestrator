import path from 'node:path'
import {defineCommand} from 'citty'
import {and, count, eq, sql} from 'drizzle-orm'
import {nowIso, openApp} from '../app/context'
import {resolveProjectConfig} from '../project/discoverConfig'
import {notionTasksDatabaseId, notionToken} from '../config/env'
import {upsertEnvVar} from '../config/envFile'
import {boards, tasks, workflows} from '../db/schema'
import {loadDeclaredPipes, loadProjectConfig} from '../project/projectConfig'
import {
  mapTaskStateToNotionStatus,
  notionAppendTaskPageLog,
  notionCreateTaskPage,
  notionAssertSharedBoardSchema,
  notionCreateBoardDataSource,
  notionEnsureBoardSchema,
  notionGetPage,
  notionWaitForTaskPipe,
  notionResolveDatabaseConnection,
  notionResolveDatabaseConnectionFromUrl,
  notionGetDataSource,
  notionGetNewComments,
  notionQueryAllDataSourcePages,
  notionUpdateTaskPageState,
  pagePipeId,
  pageState,
  pageTitle,
} from '../services/notion'
import {runTaskByExternalId} from './run'

function localStateToDisplayStatus(state: string): string {
  return mapTaskStateToNotionStatus(localTaskStateFromNotion(state))
}

function localTaskStateFromNotion(state: string): string {
  const normalized = state.toLowerCase()
  if (normalized === 'done') return 'done'
  if (normalized === 'failed') return 'failed'
  if (normalized === 'blocked') return 'blocked'
  if (normalized === 'in progress' || normalized === 'in_progress')
    return 'running'
  if (normalized === 'waiting') return 'waiting'
  if (normalized === 'queue') return 'queued'
  if (normalized === 'feedback') return 'feedback'
  return 'running' // unknown/step labels treated as running
}

const DEFAULT_RUN_CONCURRENCY = 16
const MAX_RUN_CONCURRENCY = 32
const activeQueuedTaskRuns = new Set<string>()
export const SHARED_NOTION_BOARD_ID = 'notion-shared'
const TASKS_DATABASE_ENV_KEY = 'NOTION_TASKS_DATABASE_ID'
const PIPE_OPTION_COLORS = [
  'blue',
  'green',
  'yellow',
  'orange',
  'red',
  'pink',
  'purple',
  'gray',
  'brown',
]

function normalizeRunConcurrency(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_RUN_CONCURRENCY
  }

  const rounded = Math.floor(Number(value))
  return Math.max(1, Math.min(MAX_RUN_CONCURRENCY, rounded))
}

type SharedBoardCommandOptions = {
  configPath?: string
  startDir?: string
}

type DeclaredPipeCatalog = {
  resolvedProject: Awaited<ReturnType<typeof resolveProjectConfig>>
  pipeIds: string[]
  pipeOptions: Array<{name: string; color: string}>
}

function buildPipeSelectOptions(pipeIds: string[]) {
  return pipeIds.map((pipeId, index) => ({
    name: pipeId,
    color: PIPE_OPTION_COLORS[index % PIPE_OPTION_COLORS.length] ?? 'gray',
  }))
}

function defaultProjectName(projectRoot: string): string {
  const baseName = path.basename(projectRoot).trim()
  if (!baseName) return 'NotionFlow'

  const parts = baseName
    .split(/[-_]+/)
    .map((part: string) => part.trim())
    .filter((part: string) => part.length > 0)

  if (parts.length === 0) return baseName
  return parts
    .map((part: string) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

const PIPE_MISMATCH_ERROR_PREFIX = 'pipe_mismatch:'
const PIPE_INVALID_ERROR_PREFIX = 'pipe_invalid:'
const REPAIR_TASK_COMMAND = 'notionflow integrations notion repair-task --task'

function isOwnershipQuarantined(lastError: string | null | undefined): boolean {
  return Boolean(
    lastError?.startsWith(PIPE_MISMATCH_ERROR_PREFIX) ||
    lastError?.startsWith(PIPE_INVALID_ERROR_PREFIX),
  )
}

function ownershipRepairHint(
  taskExternalId: string,
  expectedPipe: string,
): string {
  return [
    'You may have changed the Pipe property by mistake.',
    `Restore Pipe to \`${expectedPipe}\` in Notion, then run \`${REPAIR_TASK_COMMAND} ${taskExternalId}\`.`,
  ].join(' ')
}

function makePipeInvalidMessage(
  task: typeof tasks.$inferSelect,
  detail: string,
): string {
  return `${PIPE_INVALID_ERROR_PREFIX} ${detail}. ${ownershipRepairHint(task.externalTaskId, task.workflowId)}`
}

function makePipeMismatchMessage(
  task: typeof tasks.$inferSelect,
  remotePipe: string,
): string {
  return `${PIPE_MISMATCH_ERROR_PREFIX} shared-board Pipe changed from ${task.workflowId} to ${remotePipe}. ${ownershipRepairHint(task.externalTaskId, task.workflowId)}`
}

function parseBoardConfig(configJson: string): {
  databaseId?: string
  url?: string
} {
  try {
    const parsed = JSON.parse(configJson) as {databaseId?: string; url?: string}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function formatBoardDescriptor(input: {
  databaseId?: string
  externalId?: string
  url?: string | null
}): string {
  return [
    input.databaseId ? `database=${input.databaseId}` : null,
    input.externalId ? `data_source=${input.externalId}` : null,
    input.url ? `url=${input.url}` : null,
  ]
    .filter(Boolean)
    .join(' ')
}

async function reconcileSharedBoardSchema(
  token: string,
  boardExternalId: string,
  options: SharedBoardCommandOptions,
): Promise<Awaited<ReturnType<typeof notionGetDataSource>>> {
  const {pipeOptions} = await loadDeclaredPipeCatalog(options)
  await notionEnsureBoardSchema(token, boardExternalId, [], pipeOptions)
  const dataSource = await notionGetDataSource(token, boardExternalId)
  notionAssertSharedBoardSchema(dataSource)
  return dataSource
}

async function quarantineTask(
  db: Awaited<ReturnType<typeof openApp>>['db'],
  task: typeof tasks.$inferSelect,
  message: string,
): Promise<void> {
  await db
    .update(tasks)
    .set({
      state: 'blocked',
      lastError: message,
      updatedAt: nowIso(),
    })
    .where(
      and(
        eq(tasks.boardId, task.boardId),
        eq(tasks.externalTaskId, task.externalTaskId),
      ),
    )
}

async function reflectTaskQuarantineOnBoard(
  token: string,
  task: typeof tasks.$inferSelect,
  title: string,
  detail: string,
): Promise<void> {
  try {
    await notionUpdateTaskPageState(token, task.externalTaskId, 'blocked')
    await notionAppendTaskPageLog(token, task.externalTaskId, title, detail)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(
      `[warn] failed to reflect quarantine on shared-board page ${task.externalTaskId}: ${message}`,
    )
  }
}

async function loadDeclaredPipeCatalog(
  options: SharedBoardCommandOptions,
): Promise<DeclaredPipeCatalog> {
  const resolvedProject = await resolveProjectConfig({
    startDir: options.startDir ?? process.cwd(),
    configPath: options.configPath,
  })
  const declaredPipes = await loadDeclaredPipes({
    configPath: resolvedProject.configPath,
    projectRoot: resolvedProject.projectRoot,
  })

  const pipeIds = declaredPipes.map(entry => entry.definition.id)

  return {
    resolvedProject,
    pipeIds,
    pipeOptions: buildPipeSelectOptions(pipeIds),
  }
}

async function assertDeclaredPipeId(
  pipeId: string,
  options: SharedBoardCommandOptions = {},
): Promise<void> {
  const {resolvedProject, pipeIds} = await loadDeclaredPipeCatalog(options)
  if (pipeIds.includes(pipeId)) return

  throw new Error(
    [
      `Pipe \`${pipeId}\` is not declared in project config.`,
      `Config path: ${resolvedProject.configPath}`,
      `Available pipes: ${pipeIds.sort().join(', ') || '<none>'}`,
    ].join('\n'),
  )
}

function sharedBoardTitle(input: {name?: string; projectRoot: string}): string {
  const configuredName = input.name?.trim()
  if (configuredName) return configuredName
  return defaultProjectName(input.projectRoot)
}

async function createSharedBoardConnection(
  token: string,
  title: string,
  pipeOptions: Array<{name: string; color: string}>,
) {
  return notionCreateBoardDataSource(token, title, [], pipeOptions)
}

async function persistTasksDatabaseMapping(
  resolvedProject: Awaited<ReturnType<typeof resolveProjectConfig>>,
  databaseId: string,
): Promise<void> {
  const envPath = path.join(resolvedProject.projectRoot, '.env')
  await upsertEnvVar(envPath, TASKS_DATABASE_ENV_KEY, databaseId)
  process.env[TASKS_DATABASE_ENV_KEY] = databaseId
}

export async function getRegisteredSharedNotionBoard(
  options: SharedBoardCommandOptions = {},
) {
  const resolvedProject = await resolveProjectConfig({
    startDir: options.startDir ?? process.cwd(),
    configPath: options.configPath,
  })
  const {db} = await openApp({
    startDir: options.startDir ?? process.cwd(),
    configPath: resolvedProject.configPath,
  })
  const [board] = await db
    .select()
    .from(boards)
    .where(eq(boards.id, SHARED_NOTION_BOARD_ID))
    .limit(1)

  if (!board) {
    throw new Error(
      'No shared Notion board connected. Run `notionflow integrations notion setup` first.',
    )
  }

  if (board.adapter !== 'notion') {
    throw new Error(
      `Shared board ${SHARED_NOTION_BOARD_ID} is not registered as a Notion board.`,
    )
  }

  return board
}

export async function setupSharedNotionBoard(
  options: SharedBoardCommandOptions & {url?: string},
): Promise<{externalId: string; databaseId: string; url: string | null}> {
  const token = notionToken()
  if (!token) throw new Error('NOTION_API_TOKEN is required')

  const {resolvedProject, pipeOptions} = await loadDeclaredPipeCatalog({
    configPath: options.configPath,
    startDir: options.startDir,
  })
  const {db} = await openApp({
    startDir: options.startDir ?? process.cwd(),
    configPath: resolvedProject.configPath,
  })
  const requestedUrl = options.url?.trim() ?? null
  const existingDatabaseId = notionTasksDatabaseId()
  const [existingBoard] = await db
    .select()
    .from(boards)
    .where(eq(boards.id, SHARED_NOTION_BOARD_ID))
    .limit(1)
  const existingConfig = existingBoard
    ? parseBoardConfig(existingBoard.configJson)
    : {}
  const connection = requestedUrl
    ? await notionResolveDatabaseConnectionFromUrl(token, requestedUrl)
    : existingDatabaseId
      ? await notionResolveDatabaseConnection(token, existingDatabaseId)
      : existingConfig.databaseId
        ? await notionResolveDatabaseConnection(
            token,
            existingConfig.databaseId,
          )
        : await createSharedBoardConnection(
            token,
            sharedBoardTitle({
              name: (await loadProjectConfig(resolvedProject.configPath)).name,
              projectRoot: resolvedProject.projectRoot,
            }),
            pipeOptions,
          )

  const sameBoard =
    existingBoard?.externalId === connection.dataSourceId &&
    existingConfig.databaseId === connection.databaseId

  if (existingBoard && !sameBoard) {
    const [{taskCount}] = await db
      .select({taskCount: count()})
      .from(tasks)
      .where(eq(tasks.boardId, SHARED_NOTION_BOARD_ID))

    if (taskCount > 0) {
      throw new Error(
        [
          'Cannot re-run shared Notion setup against a different database while local shared-board tasks still exist.',
          `Current board: ${formatBoardDescriptor({
            databaseId: existingConfig.databaseId,
            externalId: existingBoard.externalId,
            url: existingConfig.url,
          })}`,
          `Requested board: ${formatBoardDescriptor({
            databaseId: connection.databaseId,
            externalId: connection.dataSourceId,
            url: connection.url ?? requestedUrl,
          })}`,
          `Existing local shared-board tasks: ${taskCount}`,
          'Clear or migrate local shared-board task state before running setup against a different Notion database.',
        ].join('\n'),
      )
    }
  }

  if (requestedUrl || !existingDatabaseId) {
    await persistTasksDatabaseMapping(resolvedProject, connection.databaseId)
  }

  await reconcileSharedBoardSchema(token, connection.dataSourceId, {
    configPath: resolvedProject.configPath,
    startDir: options.startDir,
  })

  const now = nowIso()
  await db
    .insert(boards)
    .values({
      id: SHARED_NOTION_BOARD_ID,
      adapter: 'notion',
      externalId: connection.dataSourceId,
      configJson: JSON.stringify({
        databaseId: connection.databaseId,
        url: connection.url ?? requestedUrl,
      }),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: boards.id,
      set: {
        adapter: 'notion',
        externalId: connection.dataSourceId,
        configJson: JSON.stringify({
          databaseId: connection.databaseId,
          url: connection.url ?? requestedUrl,
        }),
        updatedAt: now,
      },
    })

  return {
    externalId: connection.dataSourceId,
    databaseId: connection.databaseId,
    url: connection.url,
  }
}

async function upsertTask(
  db: Awaited<ReturnType<typeof openApp>>['db'],
  boardId: string,
  externalTaskId: string,
  workflowId: string,
  state: string,
): Promise<void> {
  const now = nowIso()
  const mismatchPrefix = `${PIPE_MISMATCH_ERROR_PREFIX}%`
  const invalidPrefix = `${PIPE_INVALID_ERROR_PREFIX}%`
  await db
    .insert(tasks)
    .values({
      id: crypto.randomUUID(),
      boardId,
      externalTaskId,
      workflowId,
      state,
      currentStepId: null,
      lockToken: null,
      lockExpiresAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [tasks.boardId, tasks.externalTaskId],
      set: {
        // Don't overwrite agent-managed states or ownership quarantine with a stale Notion value
        state: sql`CASE
          WHEN ${tasks.lastError} LIKE ${mismatchPrefix} OR ${tasks.lastError} LIKE ${invalidPrefix} THEN 'blocked'
          WHEN ${tasks.state} IN ('feedback', 'running') THEN ${tasks.state}
          ELSE ${state}
        END`,
        lastError: sql`CASE
          WHEN ${tasks.lastError} LIKE ${mismatchPrefix} OR ${tasks.lastError} LIKE ${invalidPrefix} THEN ${tasks.lastError}
          ELSE NULL
        END`,
        updatedAt: now,
      },
    })
}

async function ensureWorkflowRecord(
  db: Awaited<ReturnType<typeof openApp>>['db'],
  workflowId: string,
): Promise<void> {
  const [existing] = await db
    .select({id: workflows.id})
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .limit(1)

  if (existing?.id) return

  const now = nowIso()
  await db.insert(workflows).values({
    id: workflowId,
    version: 1,
    definitionYaml: '{}',
    createdAt: now,
    updatedAt: now,
  })
}

export async function syncNotionBoards(options: {
  pipeId?: string
  configPath?: string
  startDir?: string
  runQueued?: boolean
  awaitRunCompletion?: boolean
  runConcurrency?: number
  maxTransitionsPerTick?: number
  leaseMs?: number
  leaseMode?: 'strict' | 'best-effort'
  workerId?: string
}): Promise<void> {
  const token = notionToken()
  if (!token) throw new Error('NOTION_API_TOKEN is required')

  if (options.pipeId) {
    await assertDeclaredPipeId(options.pipeId, {
      configPath: options.configPath,
      startDir: options.startDir,
    })
  }

  const {resolvedProject, pipeIds} = await loadDeclaredPipeCatalog({
    startDir: options.startDir ?? process.cwd(),
    configPath: options.configPath,
  })
  const declaredPipeIds = new Set(pipeIds)

  const {db} = await openApp({
    startDir: options.startDir ?? process.cwd(),
    configPath: resolvedProject.configPath,
  })
  const board = await getRegisteredSharedNotionBoard({
    startDir: options.startDir ?? process.cwd(),
    configPath: resolvedProject.configPath,
  })

  await reconcileSharedBoardSchema(token, board.externalId, {
    configPath: resolvedProject.configPath,
    startDir: options.startDir,
  })

  let totalImported = 0
  const queuedTaskIds = new Set<string>()
  console.log(`Syncing board: ${board.id}`)

  const pages = await notionQueryAllDataSourcePages(token, board.externalId, {
    pageSize: 50,
  })
  for (const page of pages) {
    const workflowId = pagePipeId(page)
    const [existingTask] = await db
      .select()
      .from(tasks)
      .where(
        and(eq(tasks.boardId, board.id), eq(tasks.externalTaskId, page.id)),
      )
      .limit(1)

    if (!workflowId) {
      if (existingTask) {
        const message = makePipeInvalidMessage(
          existingTask,
          'missing Pipe on shared-board page',
        )
        if (existingTask.lastError !== message) {
          await quarantineTask(db, existingTask, message)
          await reflectTaskQuarantineOnBoard(
            token,
            existingTask,
            'Pipe property changed',
            message,
          )
        }
        console.log(
          `[warn] quarantined page without Pipe: ${page.id} ${pageTitle(page)} ${ownershipRepairHint(existingTask.externalTaskId, existingTask.workflowId)}`,
        )
      }
      console.log(
        `[warn] skipping page without Pipe: ${page.id} ${pageTitle(page)}`,
      )
      continue
    }
    if (!declaredPipeIds.has(workflowId)) {
      if (existingTask) {
        const message = makePipeInvalidMessage(
          existingTask,
          `undeclared Pipe ${workflowId} on shared-board page`,
        )
        if (existingTask.lastError !== message) {
          await quarantineTask(db, existingTask, message)
          await reflectTaskQuarantineOnBoard(
            token,
            existingTask,
            'Pipe property changed',
            message,
          )
        }
        console.log(
          `[warn] quarantined page with undeclared Pipe: ${page.id} ${pageTitle(page)} pipe=${workflowId} ${ownershipRepairHint(existingTask.externalTaskId, existingTask.workflowId)}`,
        )
      }
      console.log(
        `[warn] skipping page with undeclared Pipe: ${page.id} ${pageTitle(page)} pipe=${workflowId}`,
      )
      continue
    }

    if (existingTask && existingTask.workflowId !== workflowId) {
      const message = makePipeMismatchMessage(existingTask, workflowId)
      if (existingTask.lastError !== message) {
        await quarantineTask(db, existingTask, message)
        await reflectTaskQuarantineOnBoard(
          token,
          existingTask,
          'Pipe property changed',
          message,
        )
      }
      console.log(
        `[warn] quarantined page with ownership mismatch: ${page.id} ${pageTitle(page)} local=${existingTask.workflowId} remote=${workflowId} ${ownershipRepairHint(existingTask.externalTaskId, existingTask.workflowId)}`,
      )
      continue
    }

    if (existingTask && isOwnershipQuarantined(existingTask.lastError)) {
      console.log(
        `[warn] task remains quarantined until repaired: ${page.id} ${pageTitle(page)} ${ownershipRepairHint(existingTask.externalTaskId, existingTask.workflowId)}`,
      )
      continue
    }

    if (options.pipeId && workflowId !== options.pipeId) {
      continue
    }

    const notionState = pageState(page) ?? 'unknown'
    const localState = localTaskStateFromNotion(notionState)
    await ensureWorkflowRecord(db, workflowId)
    await upsertTask(db, board.id, page.id, workflowId, localState)

    totalImported += 1
    if (options.runQueued && localState === 'queued') queuedTaskIds.add(page.id)

    if (localState === 'queued') {
      console.log(`queued [${workflowId}] ${page.id} ${pageTitle(page)}`)
    } else {
      console.log(
        `synced [${workflowId}] ${page.id} ${pageTitle(page)} state=${mapTaskStateToNotionStatus(localState)}`,
      )
    }
  }

  const feedbackTasks = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.boardId, board.id), eq(tasks.state, 'feedback')))

  for (const ft of feedbackTasks) {
    if (options.pipeId && ft.workflowId !== options.pipeId) continue
    if (!ft.waitingSince) continue
    if (isOwnershipQuarantined(ft.lastError)) continue

    try {
      const newComments = await notionGetNewComments(
        token,
        ft.externalTaskId,
        ft.waitingSince,
      )
      if (!newComments) continue

      const storedVars = ft.stepVarsJson
        ? (JSON.parse(ft.stepVarsJson) as Record<string, string>)
        : {}
      storedVars.human_feedback = newComments
      await db
        .update(tasks)
        .set({
          state: 'queued',
          stepVarsJson: JSON.stringify(storedVars),
          waitingSince: null,
          updatedAt: nowIso(),
        })
        .where(
          and(
            eq(tasks.boardId, ft.boardId),
            eq(tasks.externalTaskId, ft.externalTaskId),
          ),
        )
      await notionUpdateTaskPageState(token, ft.externalTaskId, 'queued')
      await notionAppendTaskPageLog(
        token,
        ft.externalTaskId,
        'Feedback received',
        'Human reply detected. Task re-queued for resume.',
      )
      console.log(
        `[feedback] task ${ft.externalTaskId} has new comment reply -> re-queued`,
      )
      if (options.runQueued) queuedTaskIds.add(ft.externalTaskId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(
        `[warn] failed to check comments for feedback task ${ft.externalTaskId}: ${message}`,
      )
    }
  }

  console.log(
    `Sync complete: ${totalImported} tasks upserted from shared board`,
  )

  if (!options.runQueued || queuedTaskIds.size === 0) return

  const queuedTaskList = [...queuedTaskIds]
  const runConcurrency = normalizeRunConcurrency(options.runConcurrency)
  const awaitRunCompletion = options.awaitRunCompletion ?? true
  const workerCount = Math.min(runConcurrency, queuedTaskList.length)

  console.log(
    `Running queued tasks: total=${queuedTaskList.length} concurrency=${workerCount} await_completion=${awaitRunCompletion}`,
  )

  let runFailures = 0
  let nextTaskIndex = 0
  const workers = Array.from({length: workerCount}, () =>
    (async () => {
      while (true) {
        const taskIndex = nextTaskIndex
        nextTaskIndex += 1
        const taskId = queuedTaskList[taskIndex]
        if (!taskId) return

        if (activeQueuedTaskRuns.has(taskId)) {
          console.log(`[skip] queued task already in-flight: ${taskId}`)
          continue
        }

        console.log(`Running queued task: ${taskId}`)
        activeQueuedTaskRuns.add(taskId)
        try {
          await runTaskByExternalId(taskId, {
            configPath: options.configPath,
            startDir: options.startDir,
            maxTransitionsPerTick: options.maxTransitionsPerTick,
            leaseMs: options.leaseMs,
            leaseMode: options.leaseMode,
            workerId: options.workerId,
          })
        } catch (error) {
          runFailures += 1
          const message = error instanceof Error ? error.message : String(error)
          console.log(`[warn] task run failed: ${taskId} (${message})`)
        } finally {
          activeQueuedTaskRuns.delete(taskId)
        }
      }
    })(),
  )

  const finalizeRunSummary = (): void => {
    const runSuccesses = queuedTaskIds.size - runFailures
    console.log(
      `Run complete: ${runSuccesses}/${queuedTaskIds.size} queued task(s) succeeded`,
    )
  }

  if (awaitRunCompletion) {
    await Promise.all(workers)
    finalizeRunSummary()
    return
  }

  void Promise.all(workers)
    .then(() => {
      finalizeRunSummary()
    })
    .catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      console.log(`[warn] queued task worker crashed: ${message}`)
    })

  console.log(
    `Run dispatch complete: dispatched=${queuedTaskIds.size} in_flight=${activeQueuedTaskRuns.size}`,
  )
}

export async function repairQuarantinedSharedBoardTask(options: {
  taskExternalId: string
  configPath?: string
  startDir?: string
}): Promise<void> {
  const token = notionToken()
  if (!token) throw new Error('NOTION_API_TOKEN is required')

  const resolvedProject = await resolveProjectConfig({
    startDir: options.startDir ?? process.cwd(),
    configPath: options.configPath,
  })
  const {db} = await openApp({
    startDir: options.startDir ?? process.cwd(),
    configPath: resolvedProject.configPath,
  })
  const [task] = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.boardId, SHARED_NOTION_BOARD_ID),
        eq(tasks.externalTaskId, options.taskExternalId),
      ),
    )
    .limit(1)

  if (!task) {
    throw new Error(`Shared-board task not found: ${options.taskExternalId}`)
  }
  if (!isOwnershipQuarantined(task.lastError)) {
    throw new Error(
      `Task ${task.externalTaskId} is not ownership-quarantined and does not need repair.`,
    )
  }

  const page = await notionGetPage(token, task.externalTaskId)
  const remotePipe = pagePipeId(page)
  if (remotePipe !== task.workflowId) {
    throw new Error(
      [
        `Task ${task.externalTaskId} is still quarantined because its shared-board Pipe is ${remotePipe ?? '<missing>'}.`,
        `Restore Pipe to \`${task.workflowId}\` in Notion first, then run \`${REPAIR_TASK_COMMAND} ${task.externalTaskId}\`.`,
      ].join(' '),
    )
  }

  await db
    .update(tasks)
    .set({
      state: 'queued',
      waitingSince: null,
      lastError: null,
      updatedAt: nowIso(),
    })
    .where(
      and(
        eq(tasks.boardId, task.boardId),
        eq(tasks.externalTaskId, task.externalTaskId),
      ),
    )

  try {
    await notionUpdateTaskPageState(token, task.externalTaskId, 'queued')
    await notionAppendTaskPageLog(
      token,
      task.externalTaskId,
      'Pipe quarantine cleared',
      `Pipe restored to ${task.workflowId}. Task re-queued after explicit repair.`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(
      `[warn] failed to reflect quarantine repair on shared-board page ${task.externalTaskId}: ${message}`,
    )
  }
}

export const notionCmd = defineCommand({
  meta: {name: 'notion', description: 'Notion adapter commands'},
  subCommands: {
    setup: defineCommand({
      meta: {
        name: 'setup',
        description: 'Resolve, create, or adopt the shared Notion board',
      },
      args: {
        url: {type: 'string', required: false},
        config: {type: 'string', required: false},
      },
      async run({args}) {
        const board = await setupSharedNotionBoard({
          url: args.url ? String(args.url) : undefined,
          configPath: args.config ? String(args.config) : undefined,
          startDir: process.cwd(),
        })

        console.log(
          `Shared board ready: ${SHARED_NOTION_BOARD_ID} -> ${board.externalId}`,
        )
        if (board.url) console.log(`Notion URL: ${board.url}`)
      },
    }),
    'repair-task': defineCommand({
      meta: {
        name: 'repair-task',
        description: 'Clear ownership quarantine after Pipe is restored',
      },
      args: {
        task: {type: 'string', required: true},
        config: {type: 'string', required: false},
      },
      async run({args}) {
        await repairQuarantinedSharedBoardTask({
          taskExternalId: String(args.task),
          configPath: args.config ? String(args.config) : undefined,
          startDir: process.cwd(),
        })

        console.log(`Task repaired and re-queued: ${String(args.task)}`)
      },
    }),
    'create-task': defineCommand({
      meta: {
        name: 'create-task',
        description:
          'Create a task page in the shared Notion board and upsert local state',
      },
      args: {
        title: {type: 'string', required: true},
        pipe: {type: 'string', required: true},
        status: {type: 'string', required: false},
        config: {type: 'string', required: false},
      },
      async run({args}) {
        const token = notionToken()
        if (!token) throw new Error('NOTION_API_TOKEN is required')

        const pipeId = String(args.pipe)
        await assertDeclaredPipeId(pipeId, {
          configPath: args.config ? String(args.config) : undefined,
          startDir: process.cwd(),
        })

        const resolvedProject = await resolveProjectConfig({
          startDir: process.cwd(),
          configPath: args.config ? String(args.config) : undefined,
        })
        const {db} = await openApp({configPath: resolvedProject.configPath})
        const board = await getRegisteredSharedNotionBoard({
          configPath: resolvedProject.configPath,
          startDir: process.cwd(),
        })

        await reconcileSharedBoardSchema(token, board.externalId, {
          configPath: resolvedProject.configPath,
          startDir: process.cwd(),
        })
        const state = String(args.status ?? 'queue')
        const page = await notionCreateTaskPage(token, board.externalId, {
          title: String(args.title),
          state: localStateToDisplayStatus(state),
          pipeId,
        })
        await notionWaitForTaskPipe(token, page.id, pipeId)

        await ensureWorkflowRecord(db, pipeId)
        await upsertTask(
          db,
          board.id,
          page.id,
          pipeId,
          localTaskStateFromNotion(state),
        )

        console.log(`Task created: ${page.id}`)
        if (page.url) console.log(`Notion URL: ${page.url}`)
      },
    }),
    sync: defineCommand({
      meta: {
        name: 'sync',
        description: 'Pull tasks from the shared Notion board',
      },
      args: {
        pipe: {type: 'string', required: false},
        config: {type: 'string', required: false},
        run: {type: 'boolean', required: false},
        runConcurrency: {
          type: 'string',
          required: false,
          alias: 'run-concurrency',
        },
      },
      async run({args}) {
        const runConcurrency = args.runConcurrency
          ? Number.parseInt(String(args.runConcurrency), 10)
          : undefined

        await syncNotionBoards({
          pipeId: args.pipe ? String(args.pipe) : undefined,
          configPath: args.config ? String(args.config) : undefined,
          startDir: process.cwd(),
          runQueued: Boolean(args.run),
          runConcurrency: Number.isFinite(runConcurrency)
            ? runConcurrency
            : undefined,
        })
      },
    }),
  },
})
