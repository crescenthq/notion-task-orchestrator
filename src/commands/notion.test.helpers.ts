import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {vi} from 'vitest'
import {openApp} from '../app/context'
import {boards, workflows} from '../db/schema'

type NotionServiceModule = typeof import('../services/notion')

const tempDirs: string[] = []
const originalCwd = process.cwd()
const originalToken = process.env.NOTION_API_TOKEN
const originalTasksDatabaseId = process.env.NOTION_TASKS_DATABASE_ID

export async function cleanupNotionCommandTestEnv(): Promise<void> {
  process.chdir(originalCwd)
  if (originalToken === undefined) {
    delete process.env.NOTION_API_TOKEN
  } else {
    process.env.NOTION_API_TOKEN = originalToken
  }
  if (originalTasksDatabaseId === undefined) {
    delete process.env.NOTION_TASKS_DATABASE_ID
  } else {
    process.env.NOTION_TASKS_DATABASE_ID = originalTasksDatabaseId
  }

  vi.doUnmock('../services/notion')
  vi.resetModules()
  vi.restoreAllMocks()

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) continue
    await rm(dir, {recursive: true, force: true})
  }
}

export async function createProjectFixture(
  options: {
    pipeIds?: string[]
    name?: string
  } = {},
) {
  const projectRoot = await mkdtemp(
    path.join(tmpdir(), 'pipes-notion-command-test-'),
  )
  tempDirs.push(projectRoot)

  const pipeIds = options.pipeIds ?? ['alpha', 'beta']
  const pipesDir = path.join(projectRoot, 'pipes')
  await mkdir(pipesDir, {recursive: true})
  await writeFile(
    path.join(projectRoot, 'pipes.config.ts'),
    [
      'export default {',
      ...(options.name ? [`  name: ${JSON.stringify(options.name)},`] : []),
      `  pipes: [${pipeIds.map(id => JSON.stringify(`./pipes/${id}.mjs`)).join(', ')}],`,
      '};',
      '',
    ].join('\n'),
    'utf8',
  )

  for (const pipeId of pipeIds) {
    await writePipe(path.join(pipesDir, `${pipeId}.mjs`), pipeId)
  }

  return projectRoot
}

export async function setupSharedBoardProject(
  options: {
    registerBoard?: boolean
    boardExternalId?: string
    boardConfig?: {databaseId?: string; url?: string}
    token?: string
    pipeIds?: string[]
    name?: string
  } = {},
) {
  const projectRoot = await createProjectFixture({
    pipeIds: options.pipeIds,
    name: options.name,
  })
  process.chdir(projectRoot)
  process.env.NOTION_API_TOKEN = options.token ?? 'test-token'

  if (options.registerBoard !== false) {
    await registerSharedBoard(
      projectRoot,
      options.boardExternalId ?? 'ds-shared',
      options.boardConfig,
    )
  }

  const {db} = await openApp({projectRoot})
  return {projectRoot, db}
}

export function mockNotionService(
  buildOverrides: (
    actual: NotionServiceModule,
  ) => Partial<NotionServiceModule> | Promise<Partial<NotionServiceModule>>,
): void {
  vi.doMock('../services/notion', async () => {
    const actual =
      await vi.importActual<NotionServiceModule>('../services/notion')
    return {
      ...actual,
      ...(await buildOverrides(actual)),
    }
  })
}

export async function runNotionSubcommand(
  subcommandName: string,
  args: Record<string, unknown>,
): Promise<void> {
  const {notionCmd} = await import('./notion')
  const command = notionCmd as unknown as {
    subCommands: Record<
      string,
      {run: (input: {args: Record<string, unknown>}) => Promise<void>}
    >
  }

  const subcommand = command.subCommands[subcommandName]
  if (!subcommand) {
    throw new Error(`Unknown notion test subcommand: ${subcommandName}`)
  }

  await subcommand.run({args})
}

export async function registerSharedBoard(
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

export async function registerWorkflow(
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

export function buildNotionPage(
  id: string,
  title: string,
  state: string,
  pipeId?: string,
) {
  return {
    id,
    properties: {
      Name: {
        type: 'title',
        title: [{plain_text: title}],
      },
      Status: {
        type: 'select',
        select: {name: state},
      },
      ...(pipeId
        ? {
            Pipe: {
              type: 'select',
              select: {name: pipeId},
            },
          }
        : {}),
    },
  }
}

export function buildSharedBoardDataSource(id: string) {
  return {
    id,
    properties: {
      Name: {type: 'title'},
      Status: {type: 'select', select: {options: []}},
      Pipe: {type: 'select', select: {options: []}},
      'Current Action': {type: 'rich_text'},
      Progress: {type: 'rich_text'},
      PR: {type: 'url'},
    },
  }
}

async function writePipe(filePath: string, id: string): Promise<void> {
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
