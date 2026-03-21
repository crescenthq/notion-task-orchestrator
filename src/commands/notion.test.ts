import path from 'node:path'
import {readFile} from 'node:fs/promises'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {eq} from 'drizzle-orm'
import {openApp} from '../app/context'
import {boards, tasks} from '../db/schema'
import {
  buildNotionPage,
  buildSharedBoardDataSource,
  cleanupNotionCommandTestEnv,
  createProjectFixture,
  mockNotionService,
  registerSharedBoard,
  registerWorkflow,
  runNotionSubcommand,
  setupSharedBoardProject,
} from './notion.test.helpers'

describe('notion command shared board registration', () => {
  afterEach(async () => {
    await cleanupNotionCommandTestEnv()
  })

  it('setup --url registers the shared board locally and refreshes Pipe schema options', async () => {
    const {projectRoot} = await setupSharedBoardProject({registerBoard: false})

    mockNotionService(() => ({
      notionResolveDatabaseConnectionFromUrl: vi.fn(async () => ({
        databaseId: 'db-1',
        dataSourceId: 'ds-1',
        url: 'https://notion.so/shared-board',
      })),
      notionEnsureBoardSchema: vi.fn(async () => undefined),
      notionGetDataSource: vi.fn(async () =>
        buildSharedBoardDataSource('ds-1'),
      ),
    }))

    const notionService = await import('../services/notion')
    const {notionCmd, SHARED_NOTION_BOARD_ID, getRegisteredSharedNotionBoard} =
      await import('./notion')

    const setupRun = (
      notionCmd as unknown as {
        subCommands: {
          setup: {
            run: (input: {args: Record<string, unknown>}) => Promise<void>
          }
        }
      }
    ).subCommands.setup.run

    await setupRun({
      args: {
        url: 'https://www.notion.so/workspace/Shared-Board-1234567890abcdef1234567890abcdef?v=view-id',
      },
    })

    expect(
      vi.mocked(notionService.notionResolveDatabaseConnectionFromUrl),
    ).toHaveBeenCalledWith(
      'test-token',
      'https://www.notion.so/workspace/Shared-Board-1234567890abcdef1234567890abcdef?v=view-id',
    )

    const ensureSchemaCalls = vi.mocked(notionService.notionEnsureBoardSchema)
      .mock.calls
    expect(ensureSchemaCalls).toHaveLength(1)
    expect(ensureSchemaCalls[0]?.[0]).toBe('test-token')
    expect(ensureSchemaCalls[0]?.[1]).toBe('ds-1')
    expect(ensureSchemaCalls[0]?.[2]).toEqual([])
    expect(
      (ensureSchemaCalls[0]?.[3] ?? []).map(option => option.name),
    ).toEqual(['alpha', 'beta'])

    const {db} = await openApp({projectRoot})
    const [storedBoard] = await db
      .select()
      .from(boards)
      .where(eq(boards.id, SHARED_NOTION_BOARD_ID))

    expect(storedBoard?.adapter).toBe('notion')
    expect(storedBoard?.externalId).toBe('ds-1')
    expect(JSON.parse(storedBoard?.configJson ?? '{}')).toEqual({
      databaseId: 'db-1',
      url: 'https://notion.so/shared-board',
    })

    await expect(
      getRegisteredSharedNotionBoard({startDir: projectRoot}),
    ).resolves.toMatchObject({
      id: SHARED_NOTION_BOARD_ID,
      externalId: 'ds-1',
    })
  })

  it('setup creates a shared board from config name and persists NOTION_TASKS_DATABASE_ID', async () => {
    const {projectRoot} = await setupSharedBoardProject({
      registerBoard: false,
      name: 'Asmara Tasks',
    })
    delete process.env.NOTION_TASKS_DATABASE_ID

    mockNotionService(() => ({
      notionCreateBoardDataSource: vi.fn(async () => ({
        databaseId: 'db-created',
        dataSourceId: 'ds-created',
        url: 'https://notion.so/asmara-tasks',
      })),
      notionEnsureBoardSchema: vi.fn(async () => undefined),
      notionGetDataSource: vi.fn(async () =>
        buildSharedBoardDataSource('ds-created'),
      ),
    }))

    await runNotionSubcommand('setup', {})

    const notionService = await import('../services/notion')
    expect(
      vi.mocked(notionService.notionCreateBoardDataSource),
    ).toHaveBeenCalledWith(
      'test-token',
      'Asmara Tasks',
      [],
      [
        {name: 'alpha', color: 'blue'},
        {name: 'beta', color: 'green'},
      ],
    )
    expect(process.env.NOTION_TASKS_DATABASE_ID).toBe('db-created')
    await expect(
      readFile(path.join(projectRoot, '.env'), 'utf8'),
    ).resolves.toContain('NOTION_TASKS_DATABASE_ID=db-created')

    const {db} = await openApp({projectRoot})
    const [storedBoard] = await db
      .select()
      .from(boards)
      .where(eq(boards.id, 'notion-shared'))

    expect(storedBoard?.externalId).toBe('ds-created')
    expect(JSON.parse(storedBoard?.configJson ?? '{}')).toMatchObject({
      databaseId: 'db-created',
      url: 'https://notion.so/asmara-tasks',
    })
  })

  it('setup reuses the locally registered shared board when env mapping is missing', async () => {
    const {projectRoot} = await setupSharedBoardProject()
    delete process.env.NOTION_TASKS_DATABASE_ID

    mockNotionService(() => ({
      notionResolveDatabaseConnection: vi.fn(async () => ({
        databaseId: 'db-shared',
        dataSourceId: 'ds-shared',
        url: 'https://notion.so/shared-board',
      })),
      notionCreateBoardDataSource: vi.fn(async () => {
        throw new Error('should not create a new board')
      }),
      notionEnsureBoardSchema: vi.fn(async () => undefined),
      notionGetDataSource: vi.fn(async () =>
        buildSharedBoardDataSource('ds-shared'),
      ),
    }))

    await runNotionSubcommand('setup', {})

    const notionService = await import('../services/notion')
    expect(
      vi.mocked(notionService.notionResolveDatabaseConnection),
    ).toHaveBeenCalledWith('test-token', 'db-shared')
    expect(
      vi.mocked(notionService.notionCreateBoardDataSource),
    ).not.toHaveBeenCalled()
    expect(process.env.NOTION_TASKS_DATABASE_ID).toBe('db-shared')
    await expect(
      readFile(path.join(projectRoot, '.env'), 'utf8'),
    ).resolves.toContain('NOTION_TASKS_DATABASE_ID=db-shared')
  })

  it('shared board lookup fails with an actionable error when not connected', async () => {
    const {projectRoot} = await setupSharedBoardProject({registerBoard: false})

    const {getRegisteredSharedNotionBoard} = await import('./notion')

    await expect(
      getRegisteredSharedNotionBoard({startDir: projectRoot}),
    ).rejects.toThrowError(/No shared Notion board connected/)
  })

  it('setup --url fails loudly when shared board schema remains incompatible after reconcile', async () => {
    const {projectRoot} = await setupSharedBoardProject({registerBoard: false})

    mockNotionService(() => ({
      notionResolveDatabaseConnectionFromUrl: vi.fn(async () => ({
        databaseId: 'db-1',
        dataSourceId: 'ds-1',
        url: 'https://notion.so/shared-board',
      })),
      notionEnsureBoardSchema: vi.fn(async () => undefined),
      notionGetDataSource: vi.fn(async () => ({
        id: 'ds-1',
        properties: {
          State: {type: 'select'},
          Status: {type: 'select'},
          Pipe: {type: 'rich_text'},
        },
      })),
    }))

    const {setupSharedNotionBoard} = await import('./notion')
    await expect(
      setupSharedNotionBoard({
        url: 'https://notion.so/shared-board',
        startDir: projectRoot,
      }),
    ).rejects.toThrow(/Shared Notion board schema is invalid/)
  })

  it('create-task requires a pipe and writes to the registered shared board', async () => {
    const {db} = await setupSharedBoardProject()

    mockNotionService(() => ({
      notionCreateTaskPage: vi.fn(async () => ({
        id: 'page-created-1',
        url: 'https://notion.so/page-created-1',
      })),
      notionWaitForTaskPipe: vi.fn(async () => undefined),
      notionEnsureBoardSchema: vi.fn(async () => undefined),
      notionGetDataSource: vi.fn(async () =>
        buildSharedBoardDataSource('ds-shared'),
      ),
    }))

    const notionService = await import('../services/notion')
    const {SHARED_NOTION_BOARD_ID} = await import('./notion')

    await runNotionSubcommand('create-task', {
      pipe: 'alpha',
      title: 'Shared board task',
      status: 'queue',
    })

    expect(vi.mocked(notionService.notionGetDataSource)).toHaveBeenCalledWith(
      'test-token',
      'ds-shared',
    )
    expect(vi.mocked(notionService.notionCreateTaskPage)).toHaveBeenCalledWith(
      'test-token',
      'ds-shared',
      {
        title: 'Shared board task',
        state: 'Queue',
        pipeId: 'alpha',
      },
    )
    expect(vi.mocked(notionService.notionWaitForTaskPipe)).toHaveBeenCalledWith(
      'test-token',
      'page-created-1',
      'alpha',
    )
    expect(
      vi.mocked(notionService.notionEnsureBoardSchema),
    ).toHaveBeenCalledWith(
      'test-token',
      'ds-shared',
      [],
      [
        {name: 'alpha', color: 'blue'},
        {name: 'beta', color: 'green'},
      ],
    )
    const [storedTask] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.externalTaskId, 'page-created-1'))

    expect(storedTask?.boardId).toBe(SHARED_NOTION_BOARD_ID)
    expect(storedTask?.workflowId).toBe('alpha')
    expect(storedTask?.state).toBe('queued')
  })

  it('create-task fails loudly when shared board schema is incompatible', async () => {
    await setupSharedBoardProject()

    mockNotionService(() => ({
      notionEnsureBoardSchema: vi.fn(async () => undefined),
      notionGetDataSource: vi.fn(async () => ({
        id: 'ds-shared',
        properties: {
          State: {type: 'select'},
          Status: {type: 'select'},
        },
      })),
    }))

    await expect(
      runNotionSubcommand('create-task', {
        pipe: 'alpha',
        title: 'Broken board task',
        status: 'queue',
      }),
    ).rejects.toThrow(/Shared Notion board schema is invalid/)
  })

  it('sync imports only tasks for the selected pipe from the shared board', async () => {
    const {projectRoot, db} = await setupSharedBoardProject()
    const queryAllPages = vi.fn(async () => [
      buildNotionPage('page-alpha', 'Alpha task', 'Queue', 'alpha'),
      buildNotionPage('page-beta', 'Beta task', 'Queue', 'beta'),
      buildNotionPage('page-missing', 'Missing pipe', 'Queue'),
      buildNotionPage('page-unknown', 'Unknown pipe', 'Queue', 'gamma'),
    ])

    mockNotionService(() => ({
      notionQueryAllDataSourcePages: queryAllPages,
      notionGetNewComments: vi.fn(async () => ''),
      notionEnsureBoardSchema: vi.fn(async () => undefined),
      notionAppendTaskPageLog: vi.fn(async () => undefined),
      notionUpdateTaskPageState: vi.fn(async () => undefined),
      notionGetDataSource: vi.fn(async () =>
        buildSharedBoardDataSource('ds-shared'),
      ),
    }))

    const {syncNotionBoards} = await import('./notion')
    await syncNotionBoards({
      pipeId: 'alpha',
      configPath: path.join(projectRoot, 'pipes.config.ts'),
      startDir: projectRoot,
      runQueued: false,
    })

    expect(queryAllPages).toHaveBeenCalledWith('test-token', 'ds-shared', {
      pageSize: 50,
    })

    const rows = await db.select().from(tasks)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.externalTaskId).toBe('page-alpha')
    expect(rows[0]?.workflowId).toBe('alpha')
  })

  it('sync fails loudly when shared board schema is incompatible', async () => {
    const projectRoot = await createProjectFixture()
    process.chdir(projectRoot)
    process.env.NOTION_API_TOKEN = 'test-token'
    await registerSharedBoard(projectRoot, 'ds-shared')

    vi.doMock('../services/notion', async () => {
      const actual =
        await vi.importActual<typeof import('../services/notion')>(
          '../services/notion',
        )

      return {
        ...actual,
        notionEnsureBoardSchema: vi.fn(async () => undefined),
        notionGetDataSource: vi.fn(async () => ({
          id: 'ds-shared',
          properties: {
            State: {type: 'select'},
            Status: {type: 'rich_text'},
            Pipe: {type: 'select'},
          },
        })),
        notionQueryAllDataSourcePages: vi.fn(async () => []),
      }
    })

    const notionService = await import('../services/notion')
    const {syncNotionBoards} = await import('./notion')
    await expect(
      syncNotionBoards({
        configPath: path.join(projectRoot, 'pipes.config.ts'),
        startDir: projectRoot,
        runQueued: false,
      }),
    ).rejects.toThrow(/Shared Notion board schema is invalid/)

    expect(
      vi.mocked(notionService.notionQueryAllDataSourcePages),
    ).not.toHaveBeenCalled()
  })

  it('sync --pipe quarantines tasks whose remote Pipe drifted away', async () => {
    const {projectRoot, db} = await setupSharedBoardProject()
    const now = new Date().toISOString()
    await registerWorkflow(db, 'alpha')
    await db.insert(tasks).values({
      id: crypto.randomUUID(),
      boardId: 'notion-shared',
      externalTaskId: 'page-alpha-drifted',
      workflowId: 'alpha',
      state: 'feedback',
      currentStepId: null,
      stepVarsJson: null,
      waitingSince: now,
      lockToken: null,
      lockExpiresAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    })

    const queryAllPages = vi.fn(async () => [
      buildNotionPage('page-alpha-drifted', 'Alpha drifted', 'Queue', 'beta'),
      buildNotionPage('page-alpha-queued', 'Alpha queued', 'Queue', 'alpha'),
    ])

    mockNotionService(() => ({
      notionQueryAllDataSourcePages: queryAllPages,
      notionGetNewComments: vi.fn(async () => 'should-not-be-used'),
      notionEnsureBoardSchema: vi.fn(async () => undefined),
      notionAppendTaskPageLog: vi.fn(async () => undefined),
      notionUpdateTaskPageState: vi.fn(async () => undefined),
      notionGetDataSource: vi.fn(async () =>
        buildSharedBoardDataSource('ds-shared'),
      ),
    }))

    const notionService = await import('../services/notion')
    const {syncNotionBoards} = await import('./notion')
    await syncNotionBoards({
      pipeId: 'alpha',
      configPath: path.join(projectRoot, 'pipes.config.ts'),
      startDir: projectRoot,
      runQueued: false,
    })

    expect(queryAllPages).toHaveBeenCalledWith('test-token', 'ds-shared', {
      pageSize: 50,
    })

    const rows = await db.select().from(tasks)
    const drifted = rows.find(
      row => row.externalTaskId === 'page-alpha-drifted',
    )
    const queued = rows.find(row => row.externalTaskId === 'page-alpha-queued')

    expect(drifted?.workflowId).toBe('alpha')
    expect(drifted?.state).toBe('blocked')
    expect(drifted?.lastError).toContain('pipe_mismatch:')
    expect(drifted?.lastError).toContain(
      'You may have changed the Pipe property by mistake.',
    )

    expect(queued?.workflowId).toBe('alpha')
    expect(queued?.state).toBe('queued')

    expect(vi.mocked(notionService.notionGetNewComments)).not.toHaveBeenCalled()
    expect(
      vi.mocked(notionService.notionAppendTaskPageLog),
    ).toHaveBeenCalledWith(
      'test-token',
      'page-alpha-drifted',
      'Pipe property changed',
      expect.stringContaining('Restore Pipe to `alpha`'),
    )
  })

  it('setup --url allows same-board reuse and blocks switching boards when local tasks exist', async () => {
    const {projectRoot, db} = await setupSharedBoardProject({
      registerBoard: false,
    })
    await registerSharedBoard(projectRoot, 'ds-shared', {
      databaseId: 'db-shared',
      url: 'https://notion.so/original-board',
    })
    await registerWorkflow(db, 'alpha')
    await db.insert(tasks).values({
      id: crypto.randomUUID(),
      boardId: 'notion-shared',
      externalTaskId: 'page-existing',
      workflowId: 'alpha',
      state: 'queued',
      currentStepId: null,
      stepVarsJson: null,
      waitingSince: null,
      lockToken: null,
      lockExpiresAt: null,
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const ensureBoardSchema = vi.fn(async () => undefined)
    const getDataSource = vi.fn(async () =>
      buildSharedBoardDataSource('ds-shared'),
    )
    mockNotionService(() => ({
      notionResolveDatabaseConnectionFromUrl: vi
        .fn()
        .mockResolvedValueOnce({
          databaseId: 'db-shared',
          dataSourceId: 'ds-shared',
          url: 'https://notion.so/original-board',
        })
        .mockResolvedValueOnce({
          databaseId: 'db-other',
          dataSourceId: 'ds-other',
          url: 'https://notion.so/other-board',
        }),
      notionEnsureBoardSchema: ensureBoardSchema,
      notionGetDataSource: getDataSource,
    }))

    const {setupSharedNotionBoard} = await import('./notion')

    await expect(
      setupSharedNotionBoard({
        url: 'https://notion.so/original-board',
        startDir: projectRoot,
      }),
    ).resolves.toMatchObject({externalId: 'ds-shared', databaseId: 'db-shared'})

    await expect(
      setupSharedNotionBoard({
        url: 'https://notion.so/other-board',
        startDir: projectRoot,
      }),
    ).rejects.toThrow(
      /Cannot re-run shared Notion setup against a different database/,
    )

    const [storedBoard] = await db
      .select()
      .from(boards)
      .where(eq(boards.id, 'notion-shared'))
    expect(storedBoard?.externalId).toBe('ds-shared')
    expect(JSON.parse(storedBoard?.configJson ?? '{}')).toMatchObject({
      databaseId: 'db-shared',
      url: 'https://notion.so/original-board',
    })
    expect(ensureBoardSchema).toHaveBeenCalledTimes(1)
    expect(getDataSource).toHaveBeenCalledTimes(1)
    expect(ensureBoardSchema).not.toHaveBeenCalledWith(
      'test-token',
      'ds-other',
      [],
      expect.anything(),
    )
    expect(getDataSource).not.toHaveBeenCalledWith('test-token', 'ds-other')
  })

  it('setup --url allows switching boards when no shared-board tasks exist', async () => {
    const projectRoot = await createProjectFixture()
    process.chdir(projectRoot)
    process.env.NOTION_API_TOKEN = 'test-token'
    await registerSharedBoard(projectRoot, 'ds-shared', {
      databaseId: 'db-shared',
      url: 'https://notion.so/original-board',
    })

    vi.doMock('../services/notion', async () => {
      const actual =
        await vi.importActual<typeof import('../services/notion')>(
          '../services/notion',
        )

      return {
        ...actual,
        notionResolveDatabaseConnectionFromUrl: vi.fn(async () => ({
          databaseId: 'db-other',
          dataSourceId: 'ds-other',
          url: 'https://notion.so/other-board',
        })),
        notionEnsureBoardSchema: vi.fn(async () => undefined),
        notionGetDataSource: vi.fn(async () =>
          buildSharedBoardDataSource('ds-other'),
        ),
      }
    })

    const {setupSharedNotionBoard, SHARED_NOTION_BOARD_ID} =
      await import('./notion')
    await setupSharedNotionBoard({
      url: 'https://notion.so/other-board',
      startDir: projectRoot,
    })

    const {db} = await openApp({projectRoot})
    const [storedBoard] = await db
      .select()
      .from(boards)
      .where(eq(boards.id, SHARED_NOTION_BOARD_ID))
    expect(storedBoard?.externalId).toBe('ds-other')
    expect(JSON.parse(storedBoard?.configJson ?? '{}')).toMatchObject({
      databaseId: 'db-other',
      url: 'https://notion.so/other-board',
    })
  })

  it('sync paginates shared-board pages and imports later matching pipe tasks', async () => {
    const projectRoot = await createProjectFixture()
    process.chdir(projectRoot)
    process.env.NOTION_API_TOKEN = 'test-token'
    await registerSharedBoard(projectRoot, 'ds-shared')

    const queryAllPages = vi.fn(async () => [
      ...Array.from({length: 50}, (_, index) =>
        buildNotionPage(`page-beta-${index}`, `Beta ${index}`, 'Queue', 'beta'),
      ),
      buildNotionPage('page-alpha-51', 'Alpha late', 'Queue', 'alpha'),
    ])

    vi.doMock('../services/notion', async () => {
      const actual =
        await vi.importActual<typeof import('../services/notion')>(
          '../services/notion',
        )

      return {
        ...actual,
        notionQueryAllDataSourcePages: queryAllPages,
        notionGetNewComments: vi.fn(async () => ''),
        notionEnsureBoardSchema: vi.fn(async () => undefined),
        notionGetDataSource: vi.fn(async () =>
          buildSharedBoardDataSource('ds-shared'),
        ),
      }
    })

    const {syncNotionBoards} = await import('./notion')
    await syncNotionBoards({
      pipeId: 'alpha',
      configPath: path.join(projectRoot, 'pipes.config.ts'),
      startDir: projectRoot,
      runQueued: false,
    })

    expect(queryAllPages).toHaveBeenCalledWith('test-token', 'ds-shared', {
      pageSize: 50,
    })

    const {db} = await openApp({projectRoot})
    const rows = await db.select().from(tasks)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.externalTaskId).toBe('page-alpha-51')
  })

  it('quarantines ownership mismatches and invalid pipes during sync', async () => {
    const projectRoot = await createProjectFixture()
    process.chdir(projectRoot)
    process.env.NOTION_API_TOKEN = 'test-token'
    await registerSharedBoard(projectRoot, 'ds-shared')

    const {db} = await openApp({projectRoot})
    const now = new Date().toISOString()
    await registerWorkflow(db, 'alpha')
    await db.insert(tasks).values([
      {
        id: crypto.randomUUID(),
        boardId: 'notion-shared',
        externalTaskId: 'page-mismatch',
        workflowId: 'alpha',
        state: 'queued',
        currentStepId: null,
        stepVarsJson: null,
        waitingSince: null,
        lockToken: null,
        lockExpiresAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: crypto.randomUUID(),
        boardId: 'notion-shared',
        externalTaskId: 'page-missing',
        workflowId: 'alpha',
        state: 'queued',
        currentStepId: null,
        stepVarsJson: null,
        waitingSince: null,
        lockToken: null,
        lockExpiresAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: crypto.randomUUID(),
        boardId: 'notion-shared',
        externalTaskId: 'page-undeclared',
        workflowId: 'alpha',
        state: 'feedback',
        currentStepId: null,
        stepVarsJson: null,
        waitingSince: now,
        lockToken: null,
        lockExpiresAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      },
    ])

    vi.doMock('../services/notion', async () => {
      const actual =
        await vi.importActual<typeof import('../services/notion')>(
          '../services/notion',
        )

      return {
        ...actual,
        notionQueryAllDataSourcePages: vi.fn(async () => [
          buildNotionPage('page-mismatch', 'Mismatch', 'Queue', 'beta'),
          buildNotionPage('page-missing', 'Missing', 'Queue'),
          buildNotionPage('page-undeclared', 'Undeclared', 'Queue', 'gamma'),
        ]),
        notionGetNewComments: vi.fn(async () => 'should-not-be-used'),
        notionEnsureBoardSchema: vi.fn(async () => undefined),
        notionAppendTaskPageLog: vi.fn(async () => undefined),
        notionUpdateTaskPageState: vi.fn(async () => undefined),
        notionGetDataSource: vi.fn(async () =>
          buildSharedBoardDataSource('ds-shared'),
        ),
      }
    })

    const {syncNotionBoards} = await import('./notion')
    await syncNotionBoards({
      configPath: path.join(projectRoot, 'pipes.config.ts'),
      startDir: projectRoot,
      runQueued: false,
    })

    const rows = await db.select().from(tasks)
    const mismatch = rows.find(row => row.externalTaskId === 'page-mismatch')
    const missing = rows.find(row => row.externalTaskId === 'page-missing')
    const undeclared = rows.find(
      row => row.externalTaskId === 'page-undeclared',
    )

    expect(mismatch?.workflowId).toBe('alpha')
    expect(mismatch?.state).toBe('blocked')
    expect(mismatch?.lastError).toContain('pipe_mismatch:')

    expect(missing?.workflowId).toBe('alpha')
    expect(missing?.state).toBe('blocked')
    expect(missing?.lastError).toContain('pipe_invalid: missing Pipe')

    expect(undeclared?.workflowId).toBe('alpha')
    expect(undeclared?.state).toBe('blocked')
    expect(undeclared?.lastError).toContain(
      'pipe_invalid: undeclared Pipe gamma',
    )
    expect(mismatch?.lastError).toContain('Restore Pipe to `alpha`')
  })

  it('keeps ownership-quarantined tasks blocked until explicitly repaired', async () => {
    const projectRoot = await createProjectFixture()
    process.chdir(projectRoot)
    process.env.NOTION_API_TOKEN = 'test-token'
    await registerSharedBoard(projectRoot, 'ds-shared')

    const {db} = await openApp({projectRoot})
    const now = new Date().toISOString()
    await registerWorkflow(db, 'alpha')
    await db.insert(tasks).values({
      id: crypto.randomUUID(),
      boardId: 'notion-shared',
      externalTaskId: 'page-quarantined',
      workflowId: 'alpha',
      state: 'blocked',
      currentStepId: null,
      stepVarsJson: null,
      waitingSince: null,
      lockToken: null,
      lockExpiresAt: null,
      lastError:
        'pipe_mismatch: shared-board Pipe changed from alpha to beta. You may have changed the Pipe property by mistake. Restore Pipe to `alpha` in Notion, then run `pipes integrations notion repair-task --task page-quarantined`.',
      createdAt: now,
      updatedAt: now,
    })

    vi.doMock('../services/notion', async () => {
      const actual =
        await vi.importActual<typeof import('../services/notion')>(
          '../services/notion',
        )

      return {
        ...actual,
        notionQueryAllDataSourcePages: vi.fn(async () => [
          buildNotionPage('page-quarantined', 'Quarantined', 'Queue', 'alpha'),
        ]),
        notionGetNewComments: vi.fn(async () => ''),
        notionEnsureBoardSchema: vi.fn(async () => undefined),
        notionAppendTaskPageLog: vi.fn(async () => undefined),
        notionUpdateTaskPageState: vi.fn(async () => undefined),
        notionGetDataSource: vi.fn(async () =>
          buildSharedBoardDataSource('ds-shared'),
        ),
      }
    })

    const {syncNotionBoards} = await import('./notion')
    await syncNotionBoards({
      configPath: path.join(projectRoot, 'pipes.config.ts'),
      startDir: projectRoot,
      runQueued: false,
    })

    const [taskRow] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.externalTaskId, 'page-quarantined'))
    expect(taskRow?.state).toBe('blocked')
    expect(taskRow?.lastError).toContain('repair-task --task page-quarantined')
  })

  it('repairs a quarantined task after Pipe is restored', async () => {
    const {projectRoot, db} = await setupSharedBoardProject()
    const now = new Date().toISOString()
    await registerWorkflow(db, 'alpha')
    await db.insert(tasks).values({
      id: crypto.randomUUID(),
      boardId: 'notion-shared',
      externalTaskId: 'page-repair',
      workflowId: 'alpha',
      state: 'blocked',
      currentStepId: '__pipe_feedback__',
      stepVarsJson: JSON.stringify({attempts: 1}),
      waitingSince: now,
      lockToken: null,
      lockExpiresAt: null,
      lastError:
        'pipe_invalid: Missing Pipe on shared-board page. You may have changed the Pipe property by mistake. Restore Pipe to `alpha` in Notion, then run `pipes integrations notion repair-task --task page-repair`.',
      createdAt: now,
      updatedAt: now,
    })

    mockNotionService(() => ({
      notionGetPage: vi.fn(async () =>
        buildNotionPage('page-repair', 'Repair me', 'Blocked', 'alpha'),
      ),
      notionAppendTaskPageLog: vi.fn(async () => undefined),
      notionUpdateTaskPageState: vi.fn(async () => undefined),
      notionGetDataSource: vi.fn(async () =>
        buildSharedBoardDataSource('ds-shared'),
      ),
    }))

    const notionService = await import('../services/notion')
    const {repairQuarantinedSharedBoardTask} = await import('./notion')
    await repairQuarantinedSharedBoardTask({
      taskExternalId: 'page-repair',
      configPath: path.join(projectRoot, 'pipes.config.ts'),
      startDir: projectRoot,
    })

    const [taskRow] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.externalTaskId, 'page-repair'))
    expect(taskRow?.state).toBe('queued')
    expect(taskRow?.lastError).toBeNull()
    expect(taskRow?.waitingSince).toBeNull()
    expect(taskRow?.currentStepId).toBe('__pipe_feedback__')
    expect(taskRow?.stepVarsJson).toBe(JSON.stringify({attempts: 1}))

    expect(
      vi.mocked(notionService.notionUpdateTaskPageState),
    ).toHaveBeenCalledWith('test-token', 'page-repair', 'queued')
    expect(
      vi.mocked(notionService.notionAppendTaskPageLog),
    ).toHaveBeenCalledWith(
      'test-token',
      'page-repair',
      'Pipe quarantine cleared',
      'Pipe restored to alpha. Task re-queued after explicit repair.',
    )
  })

  it('repair-task fails when Pipe is still wrong and leaves task blocked', async () => {
    const {projectRoot, db} = await setupSharedBoardProject()
    const now = new Date().toISOString()
    await registerWorkflow(db, 'alpha')
    await db.insert(tasks).values({
      id: crypto.randomUUID(),
      boardId: 'notion-shared',
      externalTaskId: 'page-repair-wrong',
      workflowId: 'alpha',
      state: 'blocked',
      currentStepId: null,
      stepVarsJson: null,
      waitingSince: null,
      lockToken: null,
      lockExpiresAt: null,
      lastError:
        'pipe_mismatch: shared-board Pipe changed from alpha to beta. You may have changed the Pipe property by mistake. Restore Pipe to `alpha` in Notion, then run `pipes integrations notion repair-task --task page-repair-wrong`.',
      createdAt: now,
      updatedAt: now,
    })

    mockNotionService(() => ({
      notionGetPage: vi.fn(async () =>
        buildNotionPage('page-repair-wrong', 'Repair wrong', 'Blocked', 'beta'),
      ),
      notionAppendTaskPageLog: vi.fn(async () => undefined),
      notionUpdateTaskPageState: vi.fn(async () => undefined),
      notionGetDataSource: vi.fn(async () =>
        buildSharedBoardDataSource('ds-shared'),
      ),
    }))

    const notionService = await import('../services/notion')
    const {repairQuarantinedSharedBoardTask} = await import('./notion')

    await expect(
      repairQuarantinedSharedBoardTask({
        taskExternalId: 'page-repair-wrong',
        configPath: path.join(projectRoot, 'pipes.config.ts'),
        startDir: projectRoot,
      }),
    ).rejects.toThrow(/still quarantined because its shared-board Pipe is beta/)

    const [taskRow] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.externalTaskId, 'page-repair-wrong'))
    expect(taskRow?.state).toBe('blocked')
    expect(taskRow?.lastError).toContain('pipe_mismatch:')
    expect(
      vi.mocked(notionService.notionUpdateTaskPageState),
    ).not.toHaveBeenCalled()
    expect(
      vi.mocked(notionService.notionAppendTaskPageLog),
    ).not.toHaveBeenCalled()
  })

  it('repair-task fails when Pipe is missing and leaves task blocked', async () => {
    const {projectRoot, db} = await setupSharedBoardProject()
    const now = new Date().toISOString()
    await registerWorkflow(db, 'alpha')
    await db.insert(tasks).values({
      id: crypto.randomUUID(),
      boardId: 'notion-shared',
      externalTaskId: 'page-repair-missing',
      workflowId: 'alpha',
      state: 'blocked',
      currentStepId: null,
      stepVarsJson: null,
      waitingSince: null,
      lockToken: null,
      lockExpiresAt: null,
      lastError:
        'pipe_invalid: missing Pipe on shared-board page. You may have changed the Pipe property by mistake. Restore Pipe to `alpha` in Notion, then run `pipes integrations notion repair-task --task page-repair-missing`.',
      createdAt: now,
      updatedAt: now,
    })

    mockNotionService(() => ({
      notionGetPage: vi.fn(async () =>
        buildNotionPage('page-repair-missing', 'Repair missing', 'Blocked'),
      ),
      notionAppendTaskPageLog: vi.fn(async () => undefined),
      notionUpdateTaskPageState: vi.fn(async () => undefined),
      notionGetDataSource: vi.fn(async () =>
        buildSharedBoardDataSource('ds-shared'),
      ),
    }))

    const notionService = await import('../services/notion')
    await expect(
      runNotionSubcommand('repair-task', {
        task: 'page-repair-missing',
        config: path.join(projectRoot, 'pipes.config.ts'),
      }),
    ).rejects.toThrow(/Restore Pipe to `alpha` in Notion first/)

    const [taskRow] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.externalTaskId, 'page-repair-missing'))
    expect(taskRow?.state).toBe('blocked')
    expect(taskRow?.lastError).toContain('pipe_invalid:')
    expect(
      vi.mocked(notionService.notionUpdateTaskPageState),
    ).not.toHaveBeenCalled()
    expect(
      vi.mocked(notionService.notionAppendTaskPageLog),
    ).not.toHaveBeenCalled()
  })
})
