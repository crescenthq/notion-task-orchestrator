import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {eq} from 'drizzle-orm'
import {openApp} from '../app/context'
import {boards} from '../db/schema'

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
