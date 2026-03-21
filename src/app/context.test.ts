import {access, mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {openDatabase} from '../db/client'
import {bootstrapSchema, ensureDbDirectory} from '../db/bootstrap'
import {boards} from '../db/schema'
import {openApp} from './context'

const fixtures: string[] = []

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixturePath = fixtures.pop()
    if (!fixturePath) continue
    await rm(fixturePath, {recursive: true, force: true})
  }
})

describe('openApp', () => {
  it('reuses legacy runtime state when only .notionflow exists', async () => {
    const projectRoot = await createFixture('pipes-open-app-legacy-runtime-')
    const legacyDbPath = path.join(projectRoot, '.notionflow', 'notionflow.db')
    await ensureDbDirectory(legacyDbPath)

    const legacyApp = openDatabase(legacyDbPath)
    await bootstrapSchema(legacyApp.client)
    await legacyApp.db.insert(boards).values({
      id: 'board-1',
      adapter: 'local',
      externalId: 'external-board-1',
      configJson: '{}',
      createdAt: '2026-03-22T00:00:00.000Z',
      updatedAt: '2026-03-22T00:00:00.000Z',
    })
    legacyApp.client.close()

    const app = await openApp({projectRoot})

    expect(app.paths.root).toBe(path.join(projectRoot, '.notionflow'))
    expect(app.paths.db).toBe(legacyDbPath)
    await expect(
      access(path.join(projectRoot, '.pipes-runtime')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    })

    const result = await app.client.execute(
      'SELECT COUNT(*) AS count FROM boards;',
    )
    expect(Number(result.rows[0]?.count ?? 0)).toBe(1)

    app.client.close()
  })
})

async function createFixture(prefix: string): Promise<string> {
  const fixturePath = await mkdtemp(path.join(os.tmpdir(), prefix))
  fixtures.push(fixturePath)
  return fixturePath
}
