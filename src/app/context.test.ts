import {access, mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {eq} from 'drizzle-orm'
import {afterEach, describe, expect, it} from 'vitest'
import {openDatabase} from '../db/client'
import {bootstrapSchema, ensureDbDirectory} from '../db/bootstrap'
import {boards, runTraces, runs, tasks, workflows} from '../db/schema'
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

  it('migrates legacy task and run lifecycle values to the canonical local model', async () => {
    const projectRoot = await createFixture('pipes-open-app-lifecycle-migrate-')

    const initialApp = await openApp({projectRoot})
    const dbPath = initialApp.paths.db
    initialApp.client.close()

    const legacyApp = openDatabase(dbPath)
    const timestamp = '2026-03-22T00:00:00.000Z'
    await legacyApp.db.insert(boards).values({
      id: 'board-1',
      adapter: 'local',
      externalId: 'external-board-1',
      configJson: '{}',
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    await legacyApp.db.insert(workflows).values({
      id: 'alpha',
      version: 1,
      definitionYaml: '{}',
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    await legacyApp.db.insert(tasks).values({
      id: 'task-1',
      boardId: 'board-1',
      externalTaskId: 'external-task-1',
      workflowId: 'alpha',
      state: 'blocked',
      currentStepId: '__pipe_feedback__',
      stepVarsJson: '{}',
      waitingSince: timestamp,
      lockToken: null,
      lockExpiresAt: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    await legacyApp.db.insert(runs).values({
      id: 'run-1',
      taskId: 'task-1',
      status: 'running',
      currentStateId: '__pipe_run__',
      contextJson: '{}',
      leaseOwner: null,
      leaseExpiresAt: null,
      leaseHeartbeatAt: null,
      startedAt: timestamp,
      endedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    await legacyApp.db.insert(runTraces).values({
      id: 'trace-1',
      runId: 'run-1',
      tickId: 'tick-1',
      taskId: 'task-1',
      type: 'completed',
      stateId: '__pipe_blocked__',
      fromStateId: null,
      toStateId: null,
      event: null,
      reason: null,
      attempt: 0,
      loopIteration: 0,
      status: 'blocked',
      message: 'Needs review',
      payloadJson: null,
      timestamp,
    })
    legacyApp.client.close()

    const migratedApp = await openApp({projectRoot})
    const [task] = await migratedApp.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, 'task-1'))
    const [run] = await migratedApp.db
      .select()
      .from(runs)
      .where(eq(runs.id, 'run-1'))
    const [trace] = await migratedApp.db
      .select()
      .from(runTraces)
      .where(eq(runTraces.id, 'trace-1'))

    expect(task?.state).toBe('needs_input')
    expect(run?.status).toBe('in_progress')
    expect(trace?.status).toBe('needs_input')

    migratedApp.client.close()
  })
})

async function createFixture(prefix: string): Promise<string> {
  const fixturePath = await mkdtemp(path.join(os.tmpdir(), prefix))
  fixtures.push(fixturePath)
  return fixturePath
}
