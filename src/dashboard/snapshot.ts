import path from 'node:path'
import type {Client, Row} from '@libsql/client'
import {openApp, type OpenAppOptions} from '../app/context'

export const DASHBOARD_STATE_ORDER = [
  'running',
  'feedback',
  'queued',
  'failed',
  'blocked',
  'done',
] as const

export type DashboardTaskState = (typeof DASHBOARD_STATE_ORDER)[number]

export type DashboardSnapshotSource = {
  client: Client
  dbPath: string
  projectRoot: string
}

export type DashboardTaskRow = {
  id: string
  externalTaskId: string
  workflowId: string
  state: string
  currentStepId: string | null
  waitingSince: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
  runStatus: string | null
  runCurrentStateId: string | null
  leaseOwner: string | null
  leaseExpiresAt: string | null
  lastTraceAt: string | null
  lastTraceType: string | null
  lastTraceEvent: string | null
  lastTraceReason: string | null
  lastTraceStatus: string | null
  lastTraceMessage: string | null
}

export type DashboardRecentEvent = {
  taskId: string
  externalTaskId: string
  workflowId: string
  taskState: string
  timestamp: string
  type: string
  event: string | null
  reason: string | null
  status: string | null
  message: string | null
}

export type DashboardWorkflowSummary = {
  workflowId: string
  totalCount: number
  runningCount: number
  feedbackCount: number
  queuedCount: number
  activeCount: number
}

export type DashboardSnapshot = {
  generatedAt: string
  dbPath: string
  projectRoot: string
  totalTasks: number
  activeTasks: number
  taskCounts: Record<DashboardTaskState, number>
  tasks: DashboardTaskRow[]
  inProgressTasks: DashboardTaskRow[]
  recentEvents: DashboardRecentEvent[]
  workflows: DashboardWorkflowSummary[]
}

export type DashboardSnapshotOptions = {
  taskLimit?: number
  activeTaskLimit?: number
  recentEventLimit?: number
  workflowLimit?: number
}

const DEFAULT_TASK_LIMIT = 18
const DEFAULT_ACTIVE_TASK_LIMIT = 8
const DEFAULT_RECENT_EVENT_LIMIT = 10
const DEFAULT_WORKFLOW_LIMIT = 5

const TASK_SELECT_COLUMNS = `
SELECT
  t.id AS id,
  t.external_task_id AS externalTaskId,
  t.workflow_id AS workflowId,
  t.state AS state,
  t.current_step_id AS currentStepId,
  t.waiting_since AS waitingSince,
  t.last_error AS lastError,
  t.created_at AS createdAt,
  t.updated_at AS updatedAt,
  r.status AS runStatus,
  r.current_state_id AS runCurrentStateId,
  r.lease_owner AS leaseOwner,
  r.lease_expires_at AS leaseExpiresAt,
  tr.timestamp AS lastTraceAt,
  tr.type AS lastTraceType,
  tr.event AS lastTraceEvent,
  tr.reason AS lastTraceReason,
  tr.status AS lastTraceStatus,
  tr.message AS lastTraceMessage
FROM tasks t
LEFT JOIN runs r
  ON r.id = (
    SELECT r2.id
    FROM runs r2
    WHERE r2.task_id = t.id
    ORDER BY COALESCE(r2.updated_at, r2.created_at) DESC, r2.started_at DESC, r2.id DESC
    LIMIT 1
  )
LEFT JOIN run_traces tr
  ON tr.id = (
    SELECT rt.id
    FROM run_traces rt
    WHERE rt.task_id = t.id
    ORDER BY rt.timestamp DESC, rt.id DESC
    LIMIT 1
  )
`

const TASK_ORDER_BY = `
ORDER BY
  CASE t.state
    WHEN 'running' THEN 0
    WHEN 'feedback' THEN 1
    WHEN 'queued' THEN 2
    WHEN 'failed' THEN 3
    WHEN 'blocked' THEN 4
    WHEN 'done' THEN 5
    ELSE 6
  END ASC,
  t.updated_at DESC,
  t.external_task_id ASC
`

export async function openDashboardSnapshotSource(
  options: OpenAppOptions = {},
): Promise<DashboardSnapshotSource> {
  const {client, paths} = await openApp(options)
  return {
    client,
    dbPath: paths.db,
    projectRoot: path.dirname(paths.root),
  }
}

export async function loadDashboardSnapshot(
  source: DashboardSnapshotSource,
  options: DashboardSnapshotOptions = {},
): Promise<DashboardSnapshot> {
  const taskLimit = normalizeLimit(options.taskLimit, DEFAULT_TASK_LIMIT)
  const activeTaskLimit = normalizeLimit(
    options.activeTaskLimit,
    DEFAULT_ACTIVE_TASK_LIMIT,
  )
  const recentEventLimit = normalizeLimit(
    options.recentEventLimit,
    DEFAULT_RECENT_EVENT_LIMIT,
  )
  const workflowLimit = normalizeLimit(
    options.workflowLimit,
    DEFAULT_WORKFLOW_LIMIT,
  )

  const [taskCounts, tasks, inProgressTasks, recentEvents, workflows] =
    await Promise.all([
      loadTaskCounts(source.client),
      loadTaskRows(source.client, {
        whereSql: '',
        limit: taskLimit,
      }),
      loadTaskRows(source.client, {
        whereSql: `WHERE t.state IN ('running', 'feedback')`,
        limit: activeTaskLimit,
      }),
      loadRecentEvents(source.client, recentEventLimit),
      loadWorkflowSummaries(source.client, workflowLimit),
    ])

  return {
    generatedAt: new Date().toISOString(),
    dbPath: source.dbPath,
    projectRoot: source.projectRoot,
    totalTasks: Object.values(taskCounts).reduce(
      (sum, count) => sum + count,
      0,
    ),
    activeTasks: taskCounts.running + taskCounts.feedback,
    taskCounts,
    tasks,
    inProgressTasks,
    recentEvents,
    workflows,
  }
}

async function loadTaskCounts(
  client: Client,
): Promise<Record<DashboardTaskState, number>> {
  const counts = makeEmptyTaskCounts()
  const result = await client.execute(`
    SELECT t.state AS state, COUNT(*) AS count
    FROM tasks t
    GROUP BY t.state
  `)

  for (const row of result.rows) {
    const state = String(row.state ?? '')
      .trim()
      .toLowerCase()
    if (state in counts) {
      counts[state as DashboardTaskState] = toNumber(row.count)
    }
  }

  return counts
}

async function loadTaskRows(
  client: Client,
  input: {whereSql: string; limit: number},
): Promise<DashboardTaskRow[]> {
  const result = await client.execute({
    sql: `
      ${TASK_SELECT_COLUMNS}
      ${input.whereSql}
      ${TASK_ORDER_BY}
      LIMIT ?
    `,
    args: [input.limit],
  })

  return result.rows.map(row => mapTaskRow(row))
}

async function loadRecentEvents(
  client: Client,
  limit: number,
): Promise<DashboardRecentEvent[]> {
  const result = await client.execute({
    sql: `
      SELECT
        rt.task_id AS taskId,
        t.external_task_id AS externalTaskId,
        t.workflow_id AS workflowId,
        t.state AS taskState,
        rt.timestamp AS timestamp,
        rt.type AS type,
        rt.event AS event,
        rt.reason AS reason,
        rt.status AS status,
        rt.message AS message
      FROM run_traces rt
      INNER JOIN tasks t ON t.id = rt.task_id
      ORDER BY rt.timestamp DESC, rt.id DESC
      LIMIT ?
    `,
    args: [limit],
  })

  return result.rows.map(row => ({
    taskId: toRequiredString(row.taskId),
    externalTaskId: toRequiredString(row.externalTaskId),
    workflowId: toRequiredString(row.workflowId),
    taskState: toRequiredString(row.taskState),
    timestamp: toRequiredString(row.timestamp),
    type: toRequiredString(row.type),
    event: toNullableString(row.event),
    reason: toNullableString(row.reason),
    status: toNullableString(row.status),
    message: toNullableString(row.message),
  }))
}

async function loadWorkflowSummaries(
  client: Client,
  limit: number,
): Promise<DashboardWorkflowSummary[]> {
  const result = await client.execute({
    sql: `
      SELECT
        t.workflow_id AS workflowId,
        COUNT(*) AS totalCount,
        SUM(CASE WHEN t.state = 'running' THEN 1 ELSE 0 END) AS runningCount,
        SUM(CASE WHEN t.state = 'feedback' THEN 1 ELSE 0 END) AS feedbackCount,
        SUM(CASE WHEN t.state = 'queued' THEN 1 ELSE 0 END) AS queuedCount
      FROM tasks t
      GROUP BY t.workflow_id
      ORDER BY
        runningCount DESC,
        feedbackCount DESC,
        queuedCount DESC,
        totalCount DESC,
        t.workflow_id ASC
      LIMIT ?
    `,
    args: [limit],
  })

  return result.rows.map(row => {
    const runningCount = toNumber(row.runningCount)
    const feedbackCount = toNumber(row.feedbackCount)
    const queuedCount = toNumber(row.queuedCount)
    return {
      workflowId: toRequiredString(row.workflowId),
      totalCount: toNumber(row.totalCount),
      runningCount,
      feedbackCount,
      queuedCount,
      activeCount: runningCount + feedbackCount,
    }
  })
}

function mapTaskRow(row: Row): DashboardTaskRow {
  return {
    id: toRequiredString(row.id),
    externalTaskId: toRequiredString(row.externalTaskId),
    workflowId: toRequiredString(row.workflowId),
    state: toRequiredString(row.state),
    currentStepId: toNullableString(row.currentStepId),
    waitingSince: toNullableString(row.waitingSince),
    lastError: toNullableString(row.lastError),
    createdAt: toRequiredString(row.createdAt),
    updatedAt: toRequiredString(row.updatedAt),
    runStatus: toNullableString(row.runStatus),
    runCurrentStateId: toNullableString(row.runCurrentStateId),
    leaseOwner: toNullableString(row.leaseOwner),
    leaseExpiresAt: toNullableString(row.leaseExpiresAt),
    lastTraceAt: toNullableString(row.lastTraceAt),
    lastTraceType: toNullableString(row.lastTraceType),
    lastTraceEvent: toNullableString(row.lastTraceEvent),
    lastTraceReason: toNullableString(row.lastTraceReason),
    lastTraceStatus: toNullableString(row.lastTraceStatus),
    lastTraceMessage: toNullableString(row.lastTraceMessage),
  }
}

function makeEmptyTaskCounts(): Record<DashboardTaskState, number> {
  return {
    running: 0,
    feedback: 0,
    queued: 0,
    failed: 0,
    blocked: 0,
    done: 0,
  }
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.floor(Number(value)))
}

function toRequiredString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value)
  }
  throw new Error(`Expected string-compatible value, received ${String(value)}`)
}

function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value)
  }
  return null
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}
