import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'

const tempDirs: string[] = []
const originalCwd = process.cwd()
const originalEnv = {
  NOTION_API_TOKEN: process.env.NOTION_API_TOKEN,
  NOTION_TASKS_DATABASE_ID: process.env.NOTION_TASKS_DATABASE_ID,
}

async function createWorkspace(initialEnv = 'NOTION_API_TOKEN=test-token\n') {
  const dir = await mkdtemp(
    path.join(tmpdir(), 'pipes-shared-board-test-'),
  )
  tempDirs.push(dir)
  await writeFile(path.join(dir, '.env'), initialEnv, 'utf8')
  process.chdir(dir)
  return dir
}

describe('shared Notion board helper', () => {
  afterEach(async () => {
    process.chdir(originalCwd)

    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }

    vi.resetModules()
    vi.restoreAllMocks()

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (!dir) continue
      await rm(dir, {recursive: true, force: true})
    }
  })

  it('creates and caches a fresh shared board for the current e2e run', async () => {
    await createWorkspace(
      'NOTION_API_TOKEN=test-token\nNOTION_TASKS_DATABASE_ID=db-existing\n',
    )
    process.env.NOTION_API_TOKEN = 'test-token'
    process.env.NOTION_TASKS_DATABASE_ID = 'db-existing'

    const notionResolveDatabaseConnection = vi.fn(async () => ({
      databaseId: 'db-existing',
      dataSourceId: 'ds-existing',
      url: 'https://notion.so/existing',
    }))
    const notionGetDataSource = vi.fn(async () => ({
      id: 'ds-existing',
      database_parent: {page_id: 'page-parent'},
      properties: {},
    }))
    const notionCreateBoardDataSource = vi.fn(async () => ({
      databaseId: 'db-fresh',
      dataSourceId: 'ds-fresh',
      url: 'https://notion.so/fresh',
    }))
    const notionArchiveDatabase = vi.fn(async () => undefined)

    vi.doMock('../../src/services/notion', () => ({
      notionArchiveDatabase,
      notionCreateBoardDataSource,
      notionGetDataSource,
      notionResolveDatabaseConnection,
    }))

    const {resolveSharedBoardConnection} = await import('./sharedNotionBoard')

    await expect(resolveSharedBoardConnection()).resolves.toEqual({
      dataSourceId: 'ds-fresh',
      databaseId: 'db-fresh',
      url: 'https://notion.so/fresh',
    })
    await expect(resolveSharedBoardConnection()).resolves.toEqual({
      dataSourceId: 'ds-fresh',
      databaseId: 'db-fresh',
      url: 'https://notion.so/fresh',
    })

    expect(notionResolveDatabaseConnection).toHaveBeenCalledWith(
      'test-token',
      'db-existing',
    )
    expect(notionGetDataSource).toHaveBeenCalledWith(
      'test-token',
      'ds-existing',
    )
    expect(notionCreateBoardDataSource).toHaveBeenCalledTimes(1)
    expect(notionCreateBoardDataSource).toHaveBeenCalledWith(
      'test-token',
      expect.stringMatching(/^Pipes E2E /),
      [],
      [],
      {parentPageId: 'page-parent'},
    )
    expect(notionArchiveDatabase).not.toHaveBeenCalled()

    const persisted = JSON.parse(
      await readFile(
        path.join(process.cwd(), '.context/live-e2e-board.json'),
        'utf8',
      ),
    ) as {databaseId: string}
    expect(persisted.databaseId).toBe('db-fresh')
  })

  it('archives the previous live board before creating a new one', async () => {
    await createWorkspace(
      'NOTION_API_TOKEN=test-token\nNOTION_TASKS_DATABASE_ID=db-existing\n',
    )
    process.env.NOTION_API_TOKEN = 'test-token'
    process.env.NOTION_TASKS_DATABASE_ID = 'db-existing'
    await mkdir(path.join(process.cwd(), '.context'), {recursive: true})
    await writeFile(
      path.join(process.cwd(), '.context/live-e2e-board.json'),
      JSON.stringify({
        databaseId: 'db-previous',
        dataSourceId: 'ds-previous',
        url: 'https://notion.so/previous',
      }),
      'utf8',
    )

    const notionResolveDatabaseConnection = vi.fn(async () => ({
      databaseId: 'db-existing',
      dataSourceId: 'ds-existing',
      url: 'https://notion.so/existing',
    }))
    const notionGetDataSource = vi.fn(async () => ({
      id: 'ds-existing',
      database_parent: {page_id: 'page-parent'},
      properties: {},
    }))
    const notionCreateBoardDataSource = vi.fn(async () => ({
      databaseId: 'db-fresh',
      dataSourceId: 'ds-fresh',
      url: 'https://notion.so/fresh',
    }))
    const notionArchiveDatabase = vi.fn(async () => undefined)

    vi.doMock('../../src/services/notion', () => ({
      notionArchiveDatabase,
      notionCreateBoardDataSource,
      notionGetDataSource,
      notionResolveDatabaseConnection,
    }))

    const {resolveSharedBoardConnection} = await import('./sharedNotionBoard')
    await resolveSharedBoardConnection()

    expect(notionArchiveDatabase).toHaveBeenCalledWith(
      'test-token',
      'db-previous',
    )
  })

  it('clears stale persisted state when the previous board is already archived', async () => {
    await createWorkspace(
      'NOTION_API_TOKEN=test-token\nNOTION_TASKS_DATABASE_ID=db-existing\n',
    )
    process.env.NOTION_API_TOKEN = 'test-token'
    process.env.NOTION_TASKS_DATABASE_ID = 'db-existing'
    await mkdir(path.join(process.cwd(), '.context'), {recursive: true})
    await writeFile(
      path.join(process.cwd(), '.context/live-e2e-board.json'),
      JSON.stringify({
        databaseId: 'db-previous',
        dataSourceId: 'ds-previous',
        url: 'https://notion.so/previous',
      }),
      'utf8',
    )

    const notionResolveDatabaseConnection = vi.fn(async () => ({
      databaseId: 'db-existing',
      dataSourceId: 'ds-existing',
      url: 'https://notion.so/existing',
    }))
    const notionGetDataSource = vi.fn(async () => ({
      id: 'ds-existing',
      database_parent: {page_id: 'page-parent'},
      properties: {},
    }))
    const notionCreateBoardDataSource = vi.fn(async () => ({
      databaseId: 'db-fresh',
      dataSourceId: 'ds-fresh',
      url: 'https://notion.so/fresh',
    }))
    const notionArchiveDatabase = vi.fn(async () => {
      throw new Error('Notion database archive failed (400): already archived')
    })

    vi.doMock('../../src/services/notion', () => ({
      notionArchiveDatabase,
      notionCreateBoardDataSource,
      notionGetDataSource,
      notionResolveDatabaseConnection,
    }))

    const {resolveSharedBoardConnection} = await import('./sharedNotionBoard')
    await expect(resolveSharedBoardConnection()).resolves.toEqual({
      dataSourceId: 'ds-fresh',
      databaseId: 'db-fresh',
      url: 'https://notion.so/fresh',
    })
  })

  it('fails when no tasks database id is configured', async () => {
    await createWorkspace()
    process.env.NOTION_API_TOKEN = 'test-token'
    delete process.env.NOTION_TASKS_DATABASE_ID

    const notionArchiveDatabase = vi.fn()
    const notionCreateBoardDataSource = vi.fn()
    const notionGetDataSource = vi.fn()
    const notionResolveDatabaseConnection = vi.fn()

    vi.doMock('../../src/services/notion', () => ({
      notionArchiveDatabase,
      notionCreateBoardDataSource,
      notionGetDataSource,
      notionResolveDatabaseConnection,
    }))

    const {resolveSharedBoardConnection} = await import('./sharedNotionBoard')

    await expect(resolveSharedBoardConnection()).rejects.toThrow(
      'NOTION_TASKS_DATABASE_ID is required for live shared-board tests',
    )
    expect(notionArchiveDatabase).not.toHaveBeenCalled()
    expect(notionCreateBoardDataSource).not.toHaveBeenCalled()
    expect(notionGetDataSource).not.toHaveBeenCalled()
    expect(notionResolveDatabaseConnection).not.toHaveBeenCalled()
  })
})
