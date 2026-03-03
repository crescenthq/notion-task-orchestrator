import {defineCommand} from 'citty'
import {and, eq, sql} from 'drizzle-orm'
import {nowIso, openApp} from '../app/context'
import {resolveProjectConfig} from '../project/discoverConfig'
import {notionToken, notionWorkspacePageId} from '../config/env'
import {boards, tasks, workflows} from '../db/schema'
import {loadDeclaredFactories} from '../project/projectConfig'
import {
  mapTaskStateToNotionStatus,
  notionAppendTaskPageLog,
  notionCreateBoardDataSource,
  notionCreateTaskPage,
  notionFindPageByTitle,
  notionGetDataSource,
  notionGetNewComments,
  notionQueryDataSource,
  notionUpdateTaskPageState,
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

function toBoardTitle(boardId: string): string {
  return boardId
    .split(/[-_]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

type FactoryNotionBoardInfo = {
  boardId: string
  boardTitle: string
}

function resolveBoardTitle(
  definitionName: string | undefined,
  fallbackBoardId: string,
): string {
  if (typeof definitionName === 'string' && definitionName.trim().length > 0) {
    return definitionName.trim()
  }
  return toBoardTitle(fallbackBoardId)
}

async function resolveConfiguredFactoryBoardInfo(
  options: {
    factoryId: string
    configPath?: string
    startDir?: string
  },
): Promise<FactoryNotionBoardInfo> {
  const resolvedProject = await resolveProjectConfig({
    startDir: options.startDir ?? process.cwd(),
    configPath: options.configPath,
  })
  const declaredFactories = await loadDeclaredFactories({
    configPath: resolvedProject.configPath,
    projectRoot: resolvedProject.projectRoot,
  })

  const selectedFactory = declaredFactories.find(
    entry => entry.definition.id === options.factoryId,
  )
  if (!selectedFactory) {
    const availableFactoryIds = declaredFactories
      .map(entry => entry.definition.id)
      .sort()
    throw new Error(
      [
        `Factory \`${options.factoryId}\` is not declared in project config.`,
        `Config path: ${resolvedProject.configPath}`,
        `Available factories: ${availableFactoryIds.join(', ') || '<none>'}`,
      ].join('\n'),
    )
  }

  return {
    boardId: selectedFactory.definition.id,
    boardTitle: resolveBoardTitle(
      selectedFactory.definition.name,
      selectedFactory.definition.id,
    ),
  }
}

async function resolveConfiguredFactoryBoardInfos(
  options: {
    factoryId?: string
    configPath?: string
    startDir?: string
  },
): Promise<FactoryNotionBoardInfo[]> {
  const resolvedProject = await resolveProjectConfig({
    startDir: options.startDir ?? process.cwd(),
    configPath: options.configPath,
  })
  const declaredFactories = await loadDeclaredFactories({
    configPath: resolvedProject.configPath,
    projectRoot: resolvedProject.projectRoot,
  })

  const targetFactories = options.factoryId
    ? declaredFactories.filter(entry => entry.definition.id === options.factoryId)
    : declaredFactories

  if (options.factoryId && targetFactories.length === 0) {
    const availableFactoryIds = declaredFactories
      .map(entry => entry.definition.id)
      .sort()
    throw new Error(
      [
        `Factory \`${options.factoryId}\` is not declared in project config.`,
        `Config path: ${resolvedProject.configPath}`,
        `Available factories: ${availableFactoryIds.join(', ') || '<none>'}`,
      ].join('\n'),
    )
  }

  return targetFactories.map(entry => ({
    boardId: entry.definition.id,
    boardTitle: resolveBoardTitle(entry.definition.name, entry.definition.id),
  }))
}

async function provisionNotionBoard({
  boardId,
  title,
  parentPage,
  token,
  db,
}: {
  boardId: string
  title: string
  parentPage?: string | null
  token: string
  db: Awaited<ReturnType<typeof openApp>>['db']
}): Promise<{
  externalId: string
  databaseId: string
  url: string | null
}> {
  const parentPageId =
    parentPage ??
    notionWorkspacePageId() ??
    (await notionFindPageByTitle(token, 'NotionFlow'))
  if (!parentPageId) {
    throw new Error(
      'No parent page found. Set NOTION_WORKSPACE_PAGE_ID or pass --parent-page',
    )
  }

  const board = await notionCreateBoardDataSource(token, parentPageId, title, [])
  const now = nowIso()
  await db
    .insert(boards)
    .values({
      id: boardId,
      adapter: 'notion',
      externalId: board.dataSourceId,
      configJson: JSON.stringify({
        name: title,
        databaseId: board.databaseId,
        parentPageId,
        url: board.url,
      }),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: boards.id,
      set: {
        externalId: board.dataSourceId,
        configJson: JSON.stringify({
          name: title,
          databaseId: board.databaseId,
          parentPageId,
          url: board.url,
        }),
        updatedAt: now,
      },
    })

  return {
    externalId: board.dataSourceId,
    databaseId: board.databaseId,
    url: board.url ?? null,
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

export async function provisionConfiguredNotionBoards(
  options: {
    factoryId?: string
    parentPage?: string | null
    configPath?: string
    startDir?: string
  },
): Promise<void> {
  const token = notionToken()
  if (!token) throw new Error('NOTION_API_TOKEN is required')

  const factoryBoards = await resolveConfiguredFactoryBoardInfos({
    factoryId: options.factoryId,
    configPath: options.configPath,
    startDir: options.startDir,
  })
  if (factoryBoards.length === 0) {
    console.log('No factories declared in project config; nothing to provision.')
    return
  }

  const resolvedProject = await resolveProjectConfig({
    startDir: options.startDir ?? process.cwd(),
    configPath: options.configPath,
  })
  const {db} = await openApp({
    startDir: options.startDir ?? process.cwd(),
    configPath: resolvedProject.configPath,
  })

  let provisioned = 0
  let reused = 0
  for (const {boardId, boardTitle} of factoryBoards) {
    const [existing] = await db
      .select()
      .from(boards)
      .where(eq(boards.id, boardId))
      .limit(1)

    if (existing) {
      console.log(`[skip] board already registered for factory: ${boardId}`)
      reused += 1
      continue
    }

    await provisionNotionBoard({
      boardId,
      title: boardTitle,
      parentPage: options.parentPage,
      token,
      db,
    })
    provisioned += 1
    console.log(`Board provisioned for factory: ${boardId}`)
  }

  if (options.factoryId && factoryBoards.length === 1) {
    console.log(`Factory ${options.factoryId}: provisioned=${provisioned} reused=${reused}`)
    return
  }

  console.log(
    `Factory board sync complete: provisioned=${provisioned} reused=${reused} total=${factoryBoards.length}`,
  )
}

export async function syncNotionBoards(options: {
  boardId?: string
  factoryId?: string
  workflowId?: string
  configPath?: string
  startDir?: string
  runQueued?: boolean
  maxTransitionsPerTick?: number
  leaseMs?: number
  leaseMode?: 'strict' | 'best-effort'
  workerId?: string
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

  const resolvedFactoryInfo =
    !options.boardId && options.factoryId
      ? await resolveConfiguredFactoryBoardInfo({
          factoryId: options.factoryId,
          configPath: options.configPath,
          startDir: options.startDir ?? process.cwd(),
        })
      : undefined

  if (!options.boardId && resolvedFactoryInfo) {
    const configuredFactoryBoardId = resolvedFactoryInfo.boardId
    const configuredFactoryBoardTitle = resolvedFactoryInfo.boardTitle
    const [existingFactoryBoard] = await db
      .select()
      .from(boards)
      .where(eq(boards.id, configuredFactoryBoardId))
      .limit(1)

    if (!existingFactoryBoard) {
      await provisionNotionBoard({
        boardId: configuredFactoryBoardId,
        title: configuredFactoryBoardTitle,
        token,
        db,
      })
    }
  }

  const configuredFactoryBoardId = resolvedFactoryInfo?.boardId
  const targetBoards = options.boardId
    ? await db.select().from(boards).where(eq(boards.id, options.boardId))
    : configuredFactoryBoardId
      ? await db.select().from(boards).where(eq(boards.id, configuredFactoryBoardId))
      : await db.select().from(boards)

  const notionBoards = targetBoards.filter(board => board.adapter === 'notion')
  if (notionBoards.length === 0) {
    if (options.boardId)
      throw new Error(`No Notion board found for: ${options.boardId}`)
    throw new Error(
      'No Notion boards registered. Use integrations notion sync-factories first',
    )
  }

  let totalImported = 0
  let failedBoards = 0
  const queuedTaskIds = new Set<string>()
  for (const board of notionBoards) {
    console.log(`Syncing board: ${board.id}`)
    let imported = 0

    try {
      const pages = await notionQueryDataSource(token, board.externalId, 50)

      for (const page of pages) {
        const notionState = pageState(page) ?? 'unknown'
        const localState = localTaskStateFromNotion(notionState)
        const workflowId = options.factoryId ?? options.workflowId ?? board.id
        await ensureWorkflowRecord(db, workflowId)
        await upsertTask(db, board.id, page.id, workflowId, localState)

        imported += 1
        totalImported += 1
        if (options.runQueued && localState === 'queued')
          queuedTaskIds.add(page.id)

        if (localState === 'queued') {
          console.log(`queued [${board.id}] ${page.id} ${pageTitle(page)}`)
        } else {
          console.log(
            `synced [${board.id}] ${page.id} ${pageTitle(page)} state=${mapTaskStateToNotionStatus(localState)}`,
          )
        }
      }

      console.log(
        `Board sync complete: ${board.id} (${imported} tasks upserted)`,
      )
    } catch (error) {
      failedBoards += 1
      const message = error instanceof Error ? error.message : String(error)
      console.log(`[warn] board sync failed: ${board.id} (${message})`)
    }

    // Auto-resume tasks waiting for comment feedback
    const feedbackTasks = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.boardId, board.id), eq(tasks.state, 'feedback')))
    console.log('Tasks =>', feedbackTasks)

    for (const ft of feedbackTasks) {
      if (!ft.waitingSince) continue
      try {
        const newComments = await notionGetNewComments(
          token,
          ft.externalTaskId,
          ft.waitingSince,
        )
        console.log('New Commets =>', newComments)
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
          `[feedback] task ${ft.externalTaskId} has new comment reply → re-queued`,
        )
        if (options.runQueued) queuedTaskIds.add(ft.externalTaskId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.log(
          `[warn] failed to check comments for feedback task ${ft.externalTaskId}: ${message}`,
        )
      }
    }
  }

  console.log(
    `Sync complete: ${totalImported} tasks upserted across ${notionBoards.length - failedBoards}/${notionBoards.length} board(s)`,
  )

  if (!options.runQueued || queuedTaskIds.size === 0) return

  let runFailures = 0
  for (const taskId of queuedTaskIds) {
    console.log(`Running queued task: ${taskId}`)
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
    }
  }

  const runSuccesses = queuedTaskIds.size - runFailures
  console.log(
    `Run complete: ${runSuccesses}/${queuedTaskIds.size} queued task(s) succeeded`,
  )
}

export const notionCmd = defineCommand({
  meta: {name: 'notion', description: 'Notion adapter commands'},
  subCommands: {
    'provision-board': defineCommand({
      meta: {
        name: 'provision-board',
        description: 'Create a Notion board and register it locally',
      },
      args: {
        board: {type: 'string', required: true},
        title: {type: 'string', required: false},
        config: {type: 'string', required: false},
        parentPage: {type: 'string', required: false, alias: 'parent-page'},
      },
      async run({args}) {
        const token = notionToken()
        if (!token) throw new Error('NOTION_API_TOKEN is required')

        const boardId = String(args.board)
        const providedParent = args.parentPage ? String(args.parentPage) : null
        const title = String(
          args.title ?? toBoardTitle(boardId),
        )

        const resolvedProject = await resolveProjectConfig({
          startDir: process.cwd(),
          configPath: args.config ? String(args.config) : undefined,
        })
        const {db} = await openApp({configPath: resolvedProject.configPath})
        const board = await provisionNotionBoard({
          boardId,
          title,
          parentPage: providedParent,
          token,
          db,
        })

        console.log(`Board provisioned: ${boardId} -> ${board.externalId}`)
        if (board.url) console.log(`Notion URL: ${board.url}`)
      },
    }),
    'create-task': defineCommand({
      meta: {
        name: 'create-task',
        description:
          'Create a task page in a Notion board and upsert local state',
      },
      args: {
        board: {type: 'string', required: false},
        title: {type: 'string', required: true},
        factory: {type: 'string', required: false},
        status: {type: 'string', required: false},
        config: {type: 'string', required: false},
      },
      async run({args}) {
        const token = notionToken()
        if (!token) throw new Error('NOTION_API_TOKEN is required')

        const explicitBoardId = args.board ? String(args.board) : undefined
        const factoryId = args.factory ? String(args.factory) : undefined
        const configuredFactoryInfo =
          explicitBoardId === undefined && factoryId
            ? await resolveConfiguredFactoryBoardInfo({
                factoryId,
                configPath: args.config ? String(args.config) : undefined,
                startDir: process.cwd(),
              })
            : undefined
        const boardId = explicitBoardId ?? configuredFactoryInfo?.boardId
        const configuredFactoryBoardTitle = configuredFactoryInfo?.boardTitle
        if (!boardId) {
          throw new Error(
            'Either --board or --factory is required to identify Notion board',
          )
        }
        const factoryBoardTitle = configuredFactoryBoardTitle ?? toBoardTitle(boardId)

        const resolvedProject = await resolveProjectConfig({
          startDir: process.cwd(),
          configPath: args.config ? String(args.config) : undefined,
        })
        const {db} = await openApp({configPath: resolvedProject.configPath})
        const [existingBoard] = await db
          .select()
          .from(boards)
          .where(eq(boards.id, boardId))
          .limit(1)

        if (!existingBoard) {
          await provisionNotionBoard({
            boardId,
            title: factoryBoardTitle,
            token,
            db,
          })
        }

        const [board] = await db
          .select()
          .from(boards)
          .where(eq(boards.id, boardId))
        if (!board) throw new Error(`Board not found: ${boardId}`)

        await notionGetDataSource(token, board.externalId)
        const state = String(args.status ?? 'queue')
        const workflowId = args.factory ? String(args.factory) : 'mixed-default'
        const page = await notionCreateTaskPage(token, board.externalId, {
          title: String(args.title),
          state: localStateToDisplayStatus(state),
        })

        await ensureWorkflowRecord(db, workflowId)
        await upsertTask(
          db,
          board.id,
          page.id,
          workflowId,
          localTaskStateFromNotion(state),
        )

        console.log(`Task created: ${page.id}`)
        if (page.url) console.log(`Notion URL: ${page.url}`)
      },
    }),
    sync: defineCommand({
      meta: {name: 'sync', description: 'Pull tasks from Notion boards'},
      args: {
        board: {type: 'string', required: false},
        factory: {type: 'string', required: false},
        config: {type: 'string', required: false},
        run: {type: 'boolean', required: false},
      },
      async run({args}) {
        await syncNotionBoards({
          boardId: args.board ? String(args.board) : undefined,
          factoryId: args.factory ? String(args.factory) : undefined,
          configPath: args.config ? String(args.config) : undefined,
          startDir: process.cwd(),
          runQueued: Boolean(args.run),
        })
      },
    }),
    'sync-factories': defineCommand({
      meta: {
        name: 'sync-factories',
        description: 'Provision Notion boards for declared project factories',
      },
      args: {
        factory: {type: 'string', required: false},
        config: {type: 'string', required: false},
        parentPage: {
          type: 'string',
          required: false,
          alias: 'parent-page',
        },
      },
      async run({args}) {
        await provisionConfiguredNotionBoards({
          factoryId: args.factory ? String(args.factory) : undefined,
          parentPage: args.parentPage ? String(args.parentPage) : null,
          configPath: args.config ? String(args.config) : undefined,
          startDir: process.cwd(),
        })
      },
    }),
  },
})
