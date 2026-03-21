import {mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {notionTasksDatabaseId, notionToken} from '../../src/config/env'
import {
  notionArchiveDatabase,
  notionCreateBoardDataSource,
  notionGetDataSource,
  notionResolveDatabaseConnection,
} from '../../src/services/notion'

const LIVE_BOARD_STATE_PATH = path.resolve(
  process.cwd(),
  '.context',
  'live-e2e-board.json',
)

type SharedBoardConnection = {
  dataSourceId: string
  databaseId: string
  url: string
}

type PersistedLiveBoardState = {
  databaseId: string
  dataSourceId: string
  url: string
}

let sharedBoardPromise: Promise<SharedBoardConnection> | null = null
let registeredLiveSuiteCount = 0

async function readPersistedBoardState(): Promise<PersistedLiveBoardState | null> {
  try {
    const raw = await readFile(LIVE_BOARD_STATE_PATH, 'utf8')
    return JSON.parse(raw) as PersistedLiveBoardState
  } catch {
    return null
  }
}

async function writePersistedBoardState(
  board: SharedBoardConnection,
): Promise<void> {
  await mkdir(path.dirname(LIVE_BOARD_STATE_PATH), {recursive: true})
  await writeFile(
    LIVE_BOARD_STATE_PATH,
    JSON.stringify(board, null, 2) + '\n',
    'utf8',
  )
}

async function clearPersistedBoardState(): Promise<void> {
  await rm(LIVE_BOARD_STATE_PATH, {force: true})
}

async function archivePersistedBoard(token: string): Promise<void> {
  const persisted = await readPersistedBoardState()
  if (!persisted) return

  try {
    await notionArchiveDatabase(token, persisted.databaseId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.toLowerCase().includes('archived')) {
      throw error
    }
  }
  await clearPersistedBoardState()
}

async function archiveBoardIfPresent(
  board: SharedBoardConnection,
): Promise<void> {
  const token = notionToken()
  if (!token) return

  try {
    await notionArchiveDatabase(token, board.databaseId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.toLowerCase().includes('archived')) {
      throw error
    }
  }
  await clearPersistedBoardState()
}

async function createFreshSharedBoard(
  token: string,
  seedDatabaseId: string,
): Promise<SharedBoardConnection> {
  await archivePersistedBoard(token)

  const seedBoard = await notionResolveDatabaseConnection(token, seedDatabaseId)
  const dataSource = await notionGetDataSource(token, seedBoard.dataSourceId)
  const parentPageId = dataSource.database_parent?.page_id
  if (!parentPageId) {
    throw new Error(
      'Configured tasks database does not expose a parent page id for fresh live shared-board creation',
    )
  }

  const board = await notionCreateBoardDataSource(
    token,
    `Pipes E2E ${new Date().toISOString()}`,
    [],
    [],
    {parentPageId},
  )

  if (!board.url) {
    throw new Error('Shared board resolution did not return a Notion URL')
  }

  const resolvedBoard = {
    dataSourceId: board.dataSourceId,
    databaseId: board.databaseId,
    url: board.url,
  }
  await writePersistedBoardState(resolvedBoard)
  return resolvedBoard
}

export function registerLiveBoardSuite(): void {
  registeredLiveSuiteCount += 1
}

export async function finishLiveBoardSuite(): Promise<void> {
  registeredLiveSuiteCount = Math.max(0, registeredLiveSuiteCount - 1)
  if (registeredLiveSuiteCount !== 0 || !sharedBoardPromise) return

  const board = await sharedBoardPromise
  await archiveBoardIfPresent(board)
  sharedBoardPromise = null
}

export async function resolveSharedBoardConnection(): Promise<SharedBoardConnection> {
  const token = notionToken()
  if (!token) {
    throw new Error('NOTION_API_TOKEN is required for live shared-board tests')
  }

  const seedDatabaseId = notionTasksDatabaseId()
  if (!seedDatabaseId) {
    throw new Error(
      'NOTION_TASKS_DATABASE_ID is required for live shared-board tests',
    )
  }

  sharedBoardPromise ??= createFreshSharedBoard(token, seedDatabaseId)
  return sharedBoardPromise
}
