import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {eq} from 'drizzle-orm'
import {openApp} from '../app/context'
import {boards, tasks, workflows} from '../db/schema'

const tempDirs: string[] = []
const originalCwd = process.cwd()
const originalToken = process.env.NOTION_API_TOKEN

describe('notion command shared board registration', () => {
  afterEach(async () => {
    process.chdir(originalCwd)
    if (originalToken === undefined) {
      delete process.env.NOTION_API_TOKEN
    } else {
      process.env.NOTION_API_TOKEN = originalToken
    }

    vi.resetModules()
    vi.restoreAllMocks()

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (!dir) continue
      await rm(dir, {recursive: true, force: true})
    }
  })

  it('connect registers the shared board locally and refreshes Factory schema options', async () => {
    const projectRoot = await createProjectFixture()
    process.chdir(projectRoot)
    process.env.NOTION_API_TOKEN = 'test-token'

    vi.doMock('../services/notion', async () => {
      const actual = await vi.importActual<typeof import('../services/notion')>(
        '../services/notion',
      )

      return {
        ...actual,
        notionResolveDatabaseConnectionFromUrl: vi.fn(async () => ({
          databaseId: 'db-1',
          dataSourceId: 'ds-1',
          url: 'https://notion.so/shared-board',
        })),
        notionEnsureBoardSchema: vi.fn(async () => undefined),
      }
    })

    const notionService = await import('../services/notion')
    const {notionCmd, SHARED_NOTION_BOARD_ID, getRegisteredSharedNotionBoard} =
      await import('./notion')

    const connectRun = (
      notionCmd as unknown as {
        subCommands: {
          connect: {run: (input: {args: Record<string, unknown>}) => Promise<void>}
        }
      }
    ).subCommands.connect.run

    await connectRun({
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
    expect((ensureSchemaCalls[0]?.[3] ?? []).map(option => option.name)).toEqual([
      'alpha',
      'beta',
    ])

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

  it('shared board lookup fails with an actionable error when not connected', async () => {
    const projectRoot = await createProjectFixture()
    process.chdir(projectRoot)

    const {getRegisteredSharedNotionBoard} = await import('./notion')

    await expect(
      getRegisteredSharedNotionBoard({startDir: projectRoot}),
    ).rejects.toThrowError(/No shared Notion board connected/)
  })

  it('create-task requires a factory and writes to the registered shared board', async () => {
    const projectRoot = await createProjectFixture()
    process.chdir(projectRoot)
    process.env.NOTION_API_TOKEN = 'test-token'
    await registerSharedBoard(projectRoot, 'ds-shared')

    vi.doMock('../services/notion', async () => {
      const actual = await vi.importActual<typeof import('../services/notion')>(
        '../services/notion',
      )

      return {
        ...actual,
        notionGetDataSource: vi.fn(async () => ({id: 'ds-shared', properties: {}})),
        notionCreateTaskPage: vi.fn(async () => ({
          id: 'page-created-1',
          url: 'https://notion.so/page-created-1',
        })),
        notionEnsureBoardSchema: vi.fn(async () => undefined),
      }
    })

    const notionService = await import('../services/notion')
    const {notionCmd, SHARED_NOTION_BOARD_ID} = await import('./notion')
    const createTaskRun = (
      notionCmd as unknown as {
        subCommands: {
          'create-task': {
            run: (input: {args: Record<string, unknown>}) => Promise<void>
          }
        }
      }
    ).subCommands['create-task'].run

    await createTaskRun({
      args: {
        factory: 'alpha',
        title: 'Shared board task',
        status: 'queue',
      },
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
        factoryId: 'alpha',
      },
    )
    expect(vi.mocked(notionService.notionEnsureBoardSchema)).toHaveBeenCalledWith(
      'test-token',
      'ds-shared',
      [],
      [
        {name: 'alpha', color: 'blue'},
        {name: 'beta', color: 'green'},
      ],
    )

    const {db} = await openApp({projectRoot})
    const [storedTask] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.externalTaskId, 'page-created-1'))

    expect(storedTask?.boardId).toBe(SHARED_NOTION_BOARD_ID)
    expect(storedTask?.workflowId).toBe('alpha')
    expect(storedTask?.state).toBe('queued')
  })

  it('sync imports only tasks for the selected factory from the shared board', async () => {
    const projectRoot = await createProjectFixture()
    process.chdir(projectRoot)
    process.env.NOTION_API_TOKEN = 'test-token'
    await registerSharedBoard(projectRoot, 'ds-shared')

    vi.doMock('../services/notion', async () => {
      const actual = await vi.importActual<typeof import('../services/notion')>(
        '../services/notion',
      )

      return {
        ...actual,
        notionQueryAllDataSourcePages: vi.fn(async () => [
          buildNotionPage('page-alpha', 'Alpha task', 'Queue', 'alpha'),
          buildNotionPage('page-beta', 'Beta task', 'Queue', 'beta'),
          buildNotionPage('page-missing', 'Missing factory', 'Queue'),
          buildNotionPage('page-unknown', 'Unknown factory', 'Queue', 'gamma'),
        ]),
        notionGetNewComments: vi.fn(async () => ''),
        notionEnsureBoardSchema: vi.fn(async () => undefined),
        notionAppendTaskPageLog: vi.fn(async () => undefined),
        notionUpdateTaskPageState: vi.fn(async () => undefined),
      }
    })

    const {syncNotionBoards} = await import('./notion')
    await syncNotionBoards({
      factoryId: 'alpha',
      configPath: path.join(projectRoot, 'notionflow.config.ts'),
      startDir: projectRoot,
      runQueued: false,
    })

    const {db} = await openApp({projectRoot})
    const rows = await db.select().from(tasks)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.externalTaskId).toBe('page-alpha')
    expect(rows[0]?.workflowId).toBe('alpha')
  })

  it('sync --factory quarantines tasks whose remote Factory drifted away', async () => {
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

    vi.doMock('../services/notion', async () => {
      const actual = await vi.importActual<typeof import('../services/notion')>(
        '../services/notion',
      )

      return {
        ...actual,
        notionQueryAllDataSourcePages: vi.fn(async () => [
          buildNotionPage('page-alpha-drifted', 'Alpha drifted', 'Queue', 'beta'),
          buildNotionPage('page-alpha-queued', 'Alpha queued', 'Queue', 'alpha'),
        ]),
        notionGetNewComments: vi.fn(async () => 'should-not-be-used'),
        notionEnsureBoardSchema: vi.fn(async () => undefined),
        notionAppendTaskPageLog: vi.fn(async () => undefined),
        notionUpdateTaskPageState: vi.fn(async () => undefined),
      }
    })

    const notionService = await import('../services/notion')
    const {syncNotionBoards} = await import('./notion')
    await syncNotionBoards({
      factoryId: 'alpha',
      configPath: path.join(projectRoot, 'notionflow.config.ts'),
      startDir: projectRoot,
      runQueued: false,
    })

    const rows = await db.select().from(tasks)
    const drifted = rows.find(row => row.externalTaskId === 'page-alpha-drifted')
    const queued = rows.find(row => row.externalTaskId === 'page-alpha-queued')

    expect(drifted?.workflowId).toBe('alpha')
    expect(drifted?.state).toBe('blocked')
    expect(drifted?.lastError).toContain('factory_mismatch:')
    expect(drifted?.lastError).toContain('You may have changed the Factory property by mistake.')

    expect(queued?.workflowId).toBe('alpha')
    expect(queued?.state).toBe('queued')

    expect(vi.mocked(notionService.notionGetNewComments)).not.toHaveBeenCalled()
    expect(vi.mocked(notionService.notionAppendTaskPageLog)).toHaveBeenCalledWith(
      'test-token',
      'page-alpha-drifted',
      'Factory property changed',
      expect.stringContaining('Restore Factory to `alpha`'),
    )
  })

  it('connect allows same-board reconnect and blocks switching boards when local tasks exist', async () => {
    const projectRoot = await createProjectFixture()
    process.chdir(projectRoot)
    process.env.NOTION_API_TOKEN = 'test-token'
    await registerSharedBoard(projectRoot, 'ds-shared', {
      databaseId: 'db-shared',
      url: 'https://notion.so/original-board',
    })

    const {db} = await openApp({projectRoot})
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

    vi.doMock('../services/notion', async () => {
      const actual = await vi.importActual<typeof import('../services/notion')>(
        '../services/notion',
      )

      return {
        ...actual,
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
        notionEnsureBoardSchema: vi.fn(async () => undefined),
      }
    })

    const {connectSharedNotionBoard} = await import('./notion')

    await expect(
      connectSharedNotionBoard({
        url: 'https://notion.so/original-board',
        startDir: projectRoot,
      }),
    ).resolves.toMatchObject({externalId: 'ds-shared', databaseId: 'db-shared'})

    await expect(
      connectSharedNotionBoard({
        url: 'https://notion.so/other-board',
        startDir: projectRoot,
      }),
    ).rejects.toThrow(/Cannot reconnect shared Notion board to a different database/)
  })

  it('connect allows switching boards when no shared-board tasks exist', async () => {
    const projectRoot = await createProjectFixture()
    process.chdir(projectRoot)
    process.env.NOTION_API_TOKEN = 'test-token'
    await registerSharedBoard(projectRoot, 'ds-shared', {
      databaseId: 'db-shared',
      url: 'https://notion.so/original-board',
    })

    vi.doMock('../services/notion', async () => {
      const actual = await vi.importActual<typeof import('../services/notion')>(
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
      }
    })

    const {connectSharedNotionBoard, SHARED_NOTION_BOARD_ID} = await import('./notion')
    await connectSharedNotionBoard({
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

  it('sync paginates shared-board pages and imports later matching factory tasks', async () => {
    const projectRoot = await createProjectFixture()
    process.chdir(projectRoot)
    process.env.NOTION_API_TOKEN = 'test-token'
    await registerSharedBoard(projectRoot, 'ds-shared')

    vi.doMock('../services/notion', async () => {
      const actual = await vi.importActual<typeof import('../services/notion')>(
        '../services/notion',
      )

      return {
        ...actual,
        notionQueryAllDataSourcePages: vi.fn(async () => [
          ...Array.from({length: 50}, (_, index) =>
            buildNotionPage(`page-beta-${index}`, `Beta ${index}`, 'Queue', 'beta'),
          ),
          buildNotionPage('page-alpha-51', 'Alpha late', 'Queue', 'alpha'),
        ]),
        notionGetNewComments: vi.fn(async () => ''),
        notionEnsureBoardSchema: vi.fn(async () => undefined),
      }
    })

    const {syncNotionBoards} = await import('./notion')
    await syncNotionBoards({
      factoryId: 'alpha',
      configPath: path.join(projectRoot, 'notionflow.config.ts'),
      startDir: projectRoot,
      runQueued: false,
    })

    const {db} = await openApp({projectRoot})
    const rows = await db.select().from(tasks)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.externalTaskId).toBe('page-alpha-51')
  })

  it('quarantines ownership mismatches and invalid factories during sync', async () => {
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
      const actual = await vi.importActual<typeof import('../services/notion')>(
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
      }
    })

    const {syncNotionBoards} = await import('./notion')
    await syncNotionBoards({
      configPath: path.join(projectRoot, 'notionflow.config.ts'),
      startDir: projectRoot,
      runQueued: false,
    })

    const rows = await db.select().from(tasks)
    const mismatch = rows.find(row => row.externalTaskId === 'page-mismatch')
    const missing = rows.find(row => row.externalTaskId === 'page-missing')
    const undeclared = rows.find(row => row.externalTaskId === 'page-undeclared')

    expect(mismatch?.workflowId).toBe('alpha')
    expect(mismatch?.state).toBe('blocked')
    expect(mismatch?.lastError).toContain('factory_mismatch:')

    expect(missing?.workflowId).toBe('alpha')
    expect(missing?.state).toBe('blocked')
    expect(missing?.lastError).toContain('factory_invalid: missing Factory')

    expect(undeclared?.workflowId).toBe('alpha')
    expect(undeclared?.state).toBe('blocked')
    expect(undeclared?.lastError).toContain('factory_invalid: undeclared Factory gamma')
    expect(mismatch?.lastError).toContain('Restore Factory to `alpha`')
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
        'factory_mismatch: shared-board Factory changed from alpha to beta. You may have changed the Factory property by mistake. Restore Factory to `alpha` in Notion, then run `notionflow integrations notion repair-task --task page-quarantined`.',
      createdAt: now,
      updatedAt: now,
    })

    vi.doMock('../services/notion', async () => {
      const actual = await vi.importActual<typeof import('../services/notion')>(
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
      }
    })

    const {syncNotionBoards} = await import('./notion')
    await syncNotionBoards({
      configPath: path.join(projectRoot, 'notionflow.config.ts'),
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

  it('repairs a quarantined task after Factory is restored', async () => {
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
      externalTaskId: 'page-repair',
      workflowId: 'alpha',
      state: 'blocked',
      currentStepId: '__pipe_feedback__',
      stepVarsJson: JSON.stringify({attempts: 1}),
      waitingSince: now,
      lockToken: null,
      lockExpiresAt: null,
      lastError:
        'factory_invalid: Missing Factory on shared-board page. You may have changed the Factory property by mistake. Restore Factory to `alpha` in Notion, then run `notionflow integrations notion repair-task --task page-repair`.',
      createdAt: now,
      updatedAt: now,
    })

    vi.doMock('../services/notion', async () => {
      const actual = await vi.importActual<typeof import('../services/notion')>(
        '../services/notion',
      )

      return {
        ...actual,
        notionGetPage: vi.fn(async () =>
          buildNotionPage('page-repair', 'Repair me', 'Blocked', 'alpha'),
        ),
        notionAppendTaskPageLog: vi.fn(async () => undefined),
        notionUpdateTaskPageState: vi.fn(async () => undefined),
      }
    })

    const notionService = await import('../services/notion')
    const {repairQuarantinedSharedBoardTask} = await import('./notion')
    await repairQuarantinedSharedBoardTask({
      taskExternalId: 'page-repair',
      configPath: path.join(projectRoot, 'notionflow.config.ts'),
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

    expect(vi.mocked(notionService.notionUpdateTaskPageState)).toHaveBeenCalledWith(
      'test-token',
      'page-repair',
      'queued',
    )
    expect(vi.mocked(notionService.notionAppendTaskPageLog)).toHaveBeenCalledWith(
      'test-token',
      'page-repair',
      'Factory quarantine cleared',
      'Factory restored to alpha. Task re-queued after explicit repair.',
    )
  })
})

async function createProjectFixture(): Promise<string> {
  const projectRoot = await mkdtemp(
    path.join(tmpdir(), 'notionflow-notion-command-test-'),
  )
  tempDirs.push(projectRoot)

  const factoriesDir = path.join(projectRoot, 'factories')
  await mkdir(factoriesDir, {recursive: true})
  await writeFile(
    path.join(projectRoot, 'notionflow.config.ts'),
    [
      'export default {',
      '  factories: ["./factories/alpha.mjs", "./factories/beta.mjs"],',
      '};',
      '',
    ].join('\n'),
    'utf8',
  )
  await writeFactory(path.join(factoriesDir, 'alpha.mjs'), 'alpha')
  await writeFactory(path.join(factoriesDir, 'beta.mjs'), 'beta')

  return projectRoot
}

async function writeFactory(filePath: string, id: string): Promise<void> {
  await writeFile(
    filePath,
    [
      'export default {',
      `  id: ${JSON.stringify(id)},`,
      '  initial: {},',
      '  run: async ({ctx}) => ({...ctx, ok: true}),',
      '};',
      '',
    ].join('\n'),
    'utf8',
  )
}

async function registerSharedBoard(
  projectRoot: string,
  externalId: string,
  config: {databaseId?: string; url?: string} = {},
): Promise<void> {
  const {db} = await openApp({projectRoot})
  await db.insert(boards).values({
    id: 'notion-shared',
    adapter: 'notion',
    externalId,
    configJson: JSON.stringify({
      databaseId: config.databaseId ?? 'db-shared',
      url: config.url ?? 'https://notion.so/shared-board',
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
}

async function registerWorkflow(
  db: Awaited<ReturnType<typeof openApp>>['db'],
  id: string,
): Promise<void> {
  const now = new Date().toISOString()
  await db.insert(workflows).values({
    id,
    version: 1,
    definitionYaml: '{}',
    createdAt: now,
    updatedAt: now,
  })
}

function buildNotionPage(
  id: string,
  title: string,
  state: string,
  factoryId?: string,
) {
  return {
    id,
    properties: {
      Name: {
        type: 'title',
        title: [{plain_text: title}],
      },
      State: {
        type: 'select',
        select: {name: state},
      },
      ...(factoryId
        ? {
            Factory: {
              type: 'select',
              select: {name: factoryId},
            },
          }
        : {}),
    },
  }
}
