import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {eq} from 'drizzle-orm'
import {openApp} from '../app/context'
import {boards, tasks} from '../db/schema'

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
        notionQueryDataSource: vi.fn(async () => [
          buildNotionPage('page-alpha', 'Alpha task', 'Queue', 'alpha'),
          buildNotionPage('page-beta', 'Beta task', 'Queue', 'beta'),
          buildNotionPage('page-missing', 'Missing factory', 'Queue'),
          buildNotionPage('page-unknown', 'Unknown factory', 'Queue', 'gamma'),
        ]),
        notionGetNewComments: vi.fn(async () => ''),
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
): Promise<void> {
  const {db} = await openApp({projectRoot})
  await db.insert(boards).values({
    id: 'notion-shared',
    adapter: 'notion',
    externalId,
    configJson: JSON.stringify({databaseId: 'db-shared', url: 'https://notion.so/shared-board'}),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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
