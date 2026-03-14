import {defineCommand} from 'citty'
import {and, eq, sql} from 'drizzle-orm'
import {nowIso, openApp} from '../app/context'
import {resolveProjectConfig} from '../project/discoverConfig'
import {notionToken} from '../config/env'
import {boards, tasks, workflows} from '../db/schema'
import {loadDeclaredFactories} from '../project/projectConfig'
import {
  mapTaskStateToNotionStatus,
  notionAppendTaskPageLog,
  notionCreateTaskPage,
  notionEnsureBoardSchema,
  notionResolveDatabaseConnectionFromUrl,
  notionGetDataSource,
  notionGetNewComments,
  notionQueryDataSource,
  notionUpdateTaskPageState,
  pageFactoryId,
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
const FACTORY_OPTION_COLORS = [
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

type DeclaredFactoryCatalog = {
  resolvedProject: Awaited<ReturnType<typeof resolveProjectConfig>>
  factoryIds: string[]
  factoryOptions: Array<{name: string; color: string}>
}

function buildFactorySelectOptions(factoryIds: string[]) {
  return factoryIds.map((factoryId, index) => ({
    name: factoryId,
    color: FACTORY_OPTION_COLORS[index % FACTORY_OPTION_COLORS.length] ?? 'gray',
  }))
}

async function loadDeclaredFactoryCatalog(
  options: SharedBoardCommandOptions,
): Promise<DeclaredFactoryCatalog> {
  const resolvedProject = await resolveProjectConfig({
    startDir: options.startDir ?? process.cwd(),
    configPath: options.configPath,
  })
  const declaredFactories = await loadDeclaredFactories({
    configPath: resolvedProject.configPath,
    projectRoot: resolvedProject.projectRoot,
  })

  const factoryIds = declaredFactories.map(entry => entry.definition.id)

  return {
    resolvedProject,
    factoryIds,
    factoryOptions: buildFactorySelectOptions(factoryIds),
  }
}

async function assertDeclaredFactoryId(
  factoryId: string,
  options: SharedBoardCommandOptions = {},
): Promise<void> {
  const {resolvedProject, factoryIds} = await loadDeclaredFactoryCatalog(options)
  if (factoryIds.includes(factoryId)) return

  throw new Error(
    [
      `Factory \`${factoryId}\` is not declared in project config.`,
      `Config path: ${resolvedProject.configPath}`,
      `Available factories: ${factoryIds.sort().join(', ') || '<none>'}`,
    ].join('\n'),
  )
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
      'No shared Notion board connected. Run `notionflow integrations notion connect --url <notion-database-url>` first.',
    )
  }

  if (board.adapter !== 'notion') {
    throw new Error(
      `Shared board ${SHARED_NOTION_BOARD_ID} is not registered as a Notion board.`,
    )
  }

  return board
}

export async function connectSharedNotionBoard(
  options: SharedBoardCommandOptions & {url: string},
): Promise<{externalId: string; databaseId: string; url: string | null}> {
  const token = notionToken()
  if (!token) throw new Error('NOTION_API_TOKEN is required')

  const {resolvedProject, factoryOptions} = await loadDeclaredFactoryCatalog({
    configPath: options.configPath,
    startDir: options.startDir,
  })
  const {db} = await openApp({
    startDir: options.startDir ?? process.cwd(),
    configPath: resolvedProject.configPath,
  })
  const connection = await notionResolveDatabaseConnectionFromUrl(token, options.url)

  await notionEnsureBoardSchema(
    token,
    connection.dataSourceId,
    [],
    factoryOptions,
  )

  const now = nowIso()
  await db
    .insert(boards)
    .values({
      id: SHARED_NOTION_BOARD_ID,
      adapter: 'notion',
      externalId: connection.dataSourceId,
      configJson: JSON.stringify({
        databaseId: connection.databaseId,
        url: connection.url ?? options.url,
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
          url: connection.url ?? options.url,
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
        workflowId,
        // Don't overwrite agent-managed states (feedback, running) with a stale Notion value
        state: sql`CASE WHEN ${tasks.state} IN ('feedback', 'running') THEN ${tasks.state} ELSE ${state} END`,
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
  factoryId?: string
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

  if (options.factoryId) {
    await assertDeclaredFactoryId(options.factoryId, {
      configPath: options.configPath,
      startDir: options.startDir,
    })
  }

  const {resolvedProject, factoryIds} = await loadDeclaredFactoryCatalog({
    startDir: options.startDir ?? process.cwd(),
    configPath: options.configPath,
  })
  const declaredFactoryIds = new Set(factoryIds)

  const {db} = await openApp({
    startDir: options.startDir ?? process.cwd(),
    configPath: resolvedProject.configPath,
  })
  const board = await getRegisteredSharedNotionBoard({
    startDir: options.startDir ?? process.cwd(),
    configPath: resolvedProject.configPath,
  })

  let totalImported = 0
  const queuedTaskIds = new Set<string>()
  console.log(`Syncing board: ${board.id}`)

  const pages = await notionQueryDataSource(token, board.externalId, 50)
  for (const page of pages) {
    const workflowId = pageFactoryId(page)
    if (!workflowId) {
      console.log(`[warn] skipping page without Factory: ${page.id} ${pageTitle(page)}`)
      continue
    }
    if (options.factoryId && workflowId !== options.factoryId) {
      continue
    }
    if (!declaredFactoryIds.has(workflowId)) {
      console.log(
        `[warn] skipping page with undeclared Factory: ${page.id} ${pageTitle(page)} factory=${workflowId}`,
      )
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
    if (options.factoryId && ft.workflowId !== options.factoryId) continue
    if (!ft.waitingSince) continue

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

  console.log(`Sync complete: ${totalImported} tasks upserted from shared board`)

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

export const notionCmd = defineCommand({
  meta: {name: 'notion', description: 'Notion adapter commands'},
  subCommands: {
    connect: defineCommand({
      meta: {
        name: 'connect',
        description: 'Connect an existing shared Notion board',
      },
      args: {
        url: {type: 'string', required: true},
        config: {type: 'string', required: false},
      },
      async run({args}) {
        const board = await connectSharedNotionBoard({
          url: String(args.url),
          configPath: args.config ? String(args.config) : undefined,
          startDir: process.cwd(),
        })

        console.log(
          `Shared board connected: ${SHARED_NOTION_BOARD_ID} -> ${board.externalId}`,
        )
        if (board.url) console.log(`Notion URL: ${board.url}`)
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
        factory: {type: 'string', required: true},
        status: {type: 'string', required: false},
        config: {type: 'string', required: false},
      },
      async run({args}) {
        const token = notionToken()
        if (!token) throw new Error('NOTION_API_TOKEN is required')

        const factoryId = String(args.factory)
        await assertDeclaredFactoryId(factoryId, {
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

        await notionGetDataSource(token, board.externalId)
        const state = String(args.status ?? 'queue')
        const page = await notionCreateTaskPage(token, board.externalId, {
          title: String(args.title),
          state: localStateToDisplayStatus(state),
          factoryId,
        })

        await ensureWorkflowRecord(db, factoryId)
        await upsertTask(
          db,
          board.id,
          page.id,
          factoryId,
          localTaskStateFromNotion(state),
        )

        console.log(`Task created: ${page.id}`)
        if (page.url) console.log(`Notion URL: ${page.url}`)
      },
    }),
    sync: defineCommand({
      meta: {name: 'sync', description: 'Pull tasks from the shared Notion board'},
      args: {
        factory: {type: 'string', required: false},
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
          factoryId: args.factory ? String(args.factory) : undefined,
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
