import {mkdtemp, rm} from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {afterEach, describe, expect, it} from 'vitest'
import {nowIso, openApp} from '../app/context'
import {boards, runTraces, runs, tasks, workflows} from '../db/schema'
import {loadDashboardSnapshot, openDashboardSnapshotSource} from './snapshot'
import {buildDashboardTextView} from './text'

const projectRoots: string[] = []

describe('dashboard snapshot', () => {
  afterEach(async () => {
    for (const projectRoot of projectRoots.splice(0, projectRoots.length)) {
      await rm(projectRoot, {recursive: true, force: true})
    }
  })

  it('summarizes runtime task state, active work, and recent events', async () => {
    const projectRoot = await mkdtemp(
      path.join(tmpdir(), 'notionflow-dashboard-test-'),
    )
    projectRoots.push(projectRoot)

    const app = await openApp({projectRoot})
    const {db} = app
    const source = await openDashboardSnapshotSource({projectRoot})
    const baseTimestamp = nowIso()

    await db.insert(boards).values({
      id: 'board-1',
      adapter: 'local',
      externalId: 'board-external-1',
      configJson: '{}',
      createdAt: baseTimestamp,
      updatedAt: baseTimestamp,
    })

    await db.insert(workflows).values([
      {
        id: 'alpha',
        version: 1,
        definitionYaml: '{}',
        createdAt: baseTimestamp,
        updatedAt: baseTimestamp,
      },
      {
        id: 'beta',
        version: 1,
        definitionYaml: '{}',
        createdAt: baseTimestamp,
        updatedAt: baseTimestamp,
      },
    ])

    await db.insert(tasks).values([
      taskRecord({
        id: 'task-running',
        externalTaskId: 'page-running-123456',
        workflowId: 'alpha',
        state: 'running',
        currentStepId: 'draft_copy',
        updatedAt: '2026-03-21T10:00:10.000Z',
      }),
      taskRecord({
        id: 'task-feedback',
        externalTaskId: 'page-feedback-654321',
        workflowId: 'alpha',
        state: 'feedback',
        currentStepId: 'await_review',
        waitingSince: '2026-03-21T10:01:00.000Z',
        updatedAt: '2026-03-21T10:01:00.000Z',
      }),
      taskRecord({
        id: 'task-queued',
        externalTaskId: 'page-queued-111111',
        workflowId: 'beta',
        state: 'queued',
        updatedAt: '2026-03-21T09:58:00.000Z',
      }),
      taskRecord({
        id: 'task-failed',
        externalTaskId: 'page-failed-222222',
        workflowId: 'beta',
        state: 'failed',
        lastError: 'Model timed out during retry',
        updatedAt: '2026-03-21T09:55:00.000Z',
      }),
      taskRecord({
        id: 'task-done',
        externalTaskId: 'page-done-333333',
        workflowId: 'beta',
        state: 'done',
        updatedAt: '2026-03-21T09:40:00.000Z',
      }),
    ])

    await db.insert(runs).values([
      runRecord({
        id: 'run-running',
        taskId: 'task-running',
        status: 'running',
        currentStateId: '__pipe_run__',
        startedAt: '2026-03-21T10:00:00.000Z',
        updatedAt: '2026-03-21T10:00:10.000Z',
        leaseOwner: 'worker-42',
      }),
      runRecord({
        id: 'run-feedback',
        taskId: 'task-feedback',
        status: 'feedback',
        currentStateId: '__pipe_feedback__',
        startedAt: '2026-03-21T10:00:20.000Z',
        updatedAt: '2026-03-21T10:01:00.000Z',
      }),
      runRecord({
        id: 'run-done',
        taskId: 'task-done',
        status: 'done',
        startedAt: '2026-03-21T09:20:00.000Z',
        endedAt: '2026-03-21T09:40:00.000Z',
        updatedAt: '2026-03-21T09:40:00.000Z',
      }),
    ])

    await db.insert(runTraces).values([
      traceRecord({
        id: 'trace-running',
        runId: 'run-running',
        taskId: 'task-running',
        timestamp: '2026-03-21T10:00:09.000Z',
        type: 'step',
        event: 'draft_copy',
        reason: 'orchestrate.select',
        fromStateId: '__pipe_run__',
        toStateId: '__pipe_run__',
      }),
      traceRecord({
        id: 'trace-feedback',
        runId: 'run-feedback',
        taskId: 'task-feedback',
        timestamp: '2026-03-21T10:01:00.000Z',
        type: 'await_feedback',
        stateId: '__pipe_feedback__',
        message: 'Need human approval',
      }),
      traceRecord({
        id: 'trace-done',
        runId: 'run-done',
        taskId: 'task-done',
        timestamp: '2026-03-21T09:40:00.000Z',
        type: 'completed',
        status: 'done',
      }),
    ])

    const snapshot = await loadDashboardSnapshot(source, {
      taskLimit: 5,
      activeTaskLimit: 5,
      recentEventLimit: 3,
      workflowLimit: 2,
    })

    expect(snapshot.totalTasks).toBe(5)
    expect(snapshot.activeTasks).toBe(2)
    expect(snapshot.taskCounts).toMatchObject({
      running: 1,
      feedback: 1,
      queued: 1,
      failed: 1,
      blocked: 0,
      done: 1,
    })
    expect(snapshot.tasks.map(task => task.externalTaskId)).toEqual([
      'page-running-123456',
      'page-feedback-654321',
      'page-queued-111111',
      'page-failed-222222',
      'page-done-333333',
    ])
    expect(snapshot.inProgressTasks.map(task => task.externalTaskId)).toEqual([
      'page-running-123456',
      'page-feedback-654321',
    ])
    expect(snapshot.recentEvents[0]?.externalTaskId).toBe(
      'page-feedback-654321',
    )
    expect(snapshot.workflows[0]).toMatchObject({
      workflowId: 'alpha',
      totalCount: 2,
      activeCount: 2,
    })

    source.client.close()
    app.client.close()
  })

  it('builds stable text panels for the dashboard renderer', () => {
    const snapshot = {
      generatedAt: '2026-03-21T10:01:00.000Z',
      dbPath: '/tmp/project/.notionflow/notionflow.db',
      projectRoot: '/tmp/project',
      totalTasks: 2,
      activeTasks: 1,
      taskCounts: {
        running: 1,
        feedback: 0,
        queued: 1,
        failed: 0,
        blocked: 0,
        done: 0,
      },
      tasks: [
        {
          id: 'task-running',
          externalTaskId: 'page-running-123456',
          workflowId: 'alpha',
          state: 'running',
          currentStepId: 'draft_copy',
          waitingSince: null,
          lastError: null,
          createdAt: '2026-03-21T10:00:00.000Z',
          updatedAt: '2026-03-21T10:00:10.000Z',
          runStatus: 'running',
          runCurrentStateId: '__pipe_run__',
          leaseOwner: 'worker-42',
          leaseExpiresAt: null,
          lastTraceAt: '2026-03-21T10:00:09.000Z',
          lastTraceType: 'step',
          lastTraceEvent: 'draft_copy',
          lastTraceReason: 'orchestrate.select',
          lastTraceStatus: null,
          lastTraceMessage: null,
        },
        {
          id: 'task-queued',
          externalTaskId: 'page-queued-111111',
          workflowId: 'beta',
          state: 'queued',
          currentStepId: null,
          waitingSince: null,
          lastError: null,
          createdAt: '2026-03-21T09:55:00.000Z',
          updatedAt: '2026-03-21T09:58:00.000Z',
          runStatus: null,
          runCurrentStateId: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastTraceAt: null,
          lastTraceType: null,
          lastTraceEvent: null,
          lastTraceReason: null,
          lastTraceStatus: null,
          lastTraceMessage: null,
        },
      ],
      inProgressTasks: [
        {
          id: 'task-running',
          externalTaskId: 'page-running-123456',
          workflowId: 'alpha',
          state: 'running',
          currentStepId: 'draft_copy',
          waitingSince: null,
          lastError: null,
          createdAt: '2026-03-21T10:00:00.000Z',
          updatedAt: '2026-03-21T10:00:10.000Z',
          runStatus: 'running',
          runCurrentStateId: '__pipe_run__',
          leaseOwner: 'worker-42',
          leaseExpiresAt: null,
          lastTraceAt: '2026-03-21T10:00:09.000Z',
          lastTraceType: 'step',
          lastTraceEvent: 'draft_copy',
          lastTraceReason: 'orchestrate.select',
          lastTraceStatus: null,
          lastTraceMessage: null,
        },
      ],
      recentEvents: [
        {
          taskId: 'task-running',
          externalTaskId: 'page-running-123456',
          workflowId: 'alpha',
          taskState: 'running',
          timestamp: '2026-03-21T10:00:09.000Z',
          type: 'step',
          event: 'draft_copy',
          reason: 'orchestrate.select',
          status: null,
          message: null,
        },
      ],
      workflows: [
        {
          workflowId: 'alpha',
          totalCount: 1,
          runningCount: 1,
          feedbackCount: 0,
          queuedCount: 0,
          activeCount: 1,
        },
      ],
    } satisfies Awaited<ReturnType<typeof loadDashboardSnapshot>>

    const view = buildDashboardTextView(
      snapshot,
      Date.parse('2026-03-21T10:01:00.000Z'),
    )

    expect(view.header).toContain('NOTIONFLOW DASHBOARD')
    expect(view.summary).toContain('Pipes')
    expect(view.inProgress).toContain('page-run…23456')
    expect(view.tasks).toContain('Draft Copy')
    expect(view.events).toContain('Step Draft Copy')
    expect(view.footer).toContain('q quit')
  })
})

function taskRecord(input: {
  id: string
  externalTaskId: string
  workflowId: string
  state: string
  currentStepId?: string | null
  waitingSince?: string | null
  lastError?: string | null
  updatedAt: string
}) {
  return {
    id: input.id,
    boardId: 'board-1',
    externalTaskId: input.externalTaskId,
    workflowId: input.workflowId,
    state: input.state,
    currentStepId: input.currentStepId ?? null,
    stepVarsJson: null,
    waitingSince: input.waitingSince ?? null,
    lockToken: null,
    lockExpiresAt: null,
    lastError: input.lastError ?? null,
    createdAt: '2026-03-21T09:00:00.000Z',
    updatedAt: input.updatedAt,
  }
}

function runRecord(input: {
  id: string
  taskId: string
  status: string
  currentStateId?: string | null
  startedAt: string
  endedAt?: string | null
  updatedAt: string
  leaseOwner?: string | null
}) {
  return {
    id: input.id,
    taskId: input.taskId,
    status: input.status,
    currentStateId: input.currentStateId ?? null,
    contextJson: '{}',
    leaseOwner: input.leaseOwner ?? null,
    leaseExpiresAt: null,
    leaseHeartbeatAt: null,
    startedAt: input.startedAt,
    endedAt: input.endedAt ?? null,
    createdAt: input.startedAt,
    updatedAt: input.updatedAt,
  }
}

function traceRecord(input: {
  id: string
  runId: string
  taskId: string
  timestamp: string
  type: string
  stateId?: string | null
  fromStateId?: string | null
  toStateId?: string | null
  event?: string | null
  reason?: string | null
  status?: string | null
  message?: string | null
}) {
  return {
    id: input.id,
    runId: input.runId,
    tickId: 'tick-1',
    taskId: input.taskId,
    type: input.type,
    stateId: input.stateId ?? null,
    fromStateId: input.fromStateId ?? null,
    toStateId: input.toStateId ?? null,
    event: input.event ?? null,
    reason: input.reason ?? null,
    attempt: 0,
    loopIteration: 0,
    status: input.status ?? null,
    message: input.message ?? null,
    payloadJson: null,
    timestamp: input.timestamp,
  }
}
