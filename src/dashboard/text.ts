import path from 'node:path'
import {
  DASHBOARD_STATE_ORDER,
  type DashboardRecentEvent,
  type DashboardSnapshot,
  type DashboardTaskRow,
} from './snapshot'
import {formatStatusLabel} from '../services/statusIcons'

export type DashboardTextView = {
  header: string
  summary: string
  inProgress: string
  tasks: string
  events: string
  footer: string
}

type TableColumn<T> = {
  width: number
  label: string
  value: (row: T) => string
}

export function buildDashboardTextView(
  snapshot: DashboardSnapshot,
  now = Date.now(),
): DashboardTextView {
  const projectName = path.basename(snapshot.projectRoot)
  const latestEventTimestamp = snapshot.recentEvents[0]?.timestamp ?? null
  const totalShown = snapshot.tasks.length
  const totalEventsShown = snapshot.recentEvents.length

  return {
    header: [
      'PIPES DASHBOARD',
      `Project: ${projectName}`,
      `Path: ${snapshot.projectRoot}`,
      `Runtime DB: ${snapshot.dbPath}`,
      [
        `Tasks ${snapshot.totalTasks}`,
        `Active ${snapshot.activeTasks}`,
        `Updated ${formatTime(snapshot.generatedAt)}`,
        `Last event ${formatRelativeTime(latestEventTimestamp, now)}`,
      ].join('  |  '),
    ].join('\n'),
    summary: buildSummaryPanel(snapshot),
    inProgress: buildInProgressPanel(snapshot.inProgressTasks, now),
    tasks: buildTasksPanel(
      snapshot.tasks,
      now,
      snapshot.totalTasks,
      totalShown,
    ),
    events: buildEventsPanel(snapshot.recentEvents, now, totalEventsShown),
    footer: 'q quit  |  r refresh now',
  }
}

export function buildSummaryPanel(snapshot: DashboardSnapshot): string {
  const countLines = DASHBOARD_STATE_ORDER.map(
    state =>
      `${pad(formatStatusLabel(state), 12)} ${String(snapshot.taskCounts[state]).padStart(3)}`,
  )
  const workflowLines =
    snapshot.workflows.length === 0
      ? ['No pipes registered yet.']
      : snapshot.workflows.map(workflow => {
          const parts = [
            `${fit(workflow.workflowId, 16).padEnd(16)}`,
            `${String(workflow.totalCount).padStart(2)} total`,
          ]
          if (workflow.activeCount > 0) {
            parts.push(`${String(workflow.activeCount).padStart(2)} active`)
          }
          if (workflow.queuedCount > 0) {
            parts.push(`${String(workflow.queuedCount).padStart(2)} queued`)
          }
          return parts.join('  ')
        })

  return ['States', ...countLines, '', 'Pipes', ...workflowLines].join('\n')
}

export function buildInProgressPanel(
  tasks: ReadonlyArray<DashboardTaskRow>,
  now = Date.now(),
): string {
  if (tasks.length === 0) {
    return 'No tasks are currently running or waiting for feedback.'
  }

  return buildTaskTable(tasks, [
    {
      width: 14,
      label: 'TASK',
      value: task => compactId(task.externalTaskId),
    },
    {
      width: 14,
      label: 'PIPE',
      value: task => task.workflowId,
    },
    {
      width: 12,
      label: 'STATE',
      value: task => formatStatusLabel(task.state),
    },
    {
      width: 16,
      label: 'STEP',
      value: task => formatTaskStep(task),
    },
    {
      width: 10,
      label: 'UPDATED',
      value: task => formatRelativeTime(task.updatedAt, now),
    },
  ])
}

export function buildTasksPanel(
  tasks: ReadonlyArray<DashboardTaskRow>,
  now = Date.now(),
  totalTasks = tasks.length,
  shownTasks = tasks.length,
): string {
  if (tasks.length === 0) {
    return 'No local tasks found. Run `pipes integrations notion sync` or create a task first.'
  }

  const table = buildTaskTable(tasks, [
    {
      width: 14,
      label: 'TASK',
      value: task => compactId(task.externalTaskId),
    },
    {
      width: 12,
      label: 'PIPE',
      value: task => task.workflowId,
    },
    {
      width: 12,
      label: 'STATE',
      value: task => formatStatusLabel(task.state),
    },
    {
      width: 14,
      label: 'STEP',
      value: task => formatTaskStep(task),
    },
    {
      width: 9,
      label: 'AGE',
      value: task => formatRelativeTime(task.updatedAt, now),
    },
    {
      width: 34,
      label: 'DETAIL',
      value: task => formatTaskDetail(task),
    },
  ])

  if (shownTasks >= totalTasks) return table
  return `${table}\n\nShowing ${shownTasks} of ${totalTasks} task(s)`
}

export function buildEventsPanel(
  events: ReadonlyArray<DashboardRecentEvent>,
  now = Date.now(),
  shownEvents = events.length,
): string {
  if (events.length === 0) {
    return 'No run trace activity recorded yet.'
  }

  const lines = events.map(event =>
    [
      formatTime(event.timestamp).padEnd(8),
      compactId(event.externalTaskId, 6, 4).padEnd(12),
      fit(formatRecentEventLabel(event), 34).padEnd(34),
      fit(formatRelativeTime(event.timestamp, now), 8).padStart(8),
    ].join('  '),
  )

  return [
    `${'TIME'.padEnd(8)}  ${'TASK'.padEnd(12)}  ${'EVENT'.padEnd(34)}  ${'AGE'.padStart(8)}`,
    rule(70),
    ...lines,
    '',
    `Showing ${shownEvents} recent event(s)`,
  ].join('\n')
}

export function formatRelativeTime(
  iso: string | null | undefined,
  now = Date.now(),
): string {
  if (!iso) return 'n/a'
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return 'n/a'

  const deltaSeconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (deltaSeconds < 60) return `${deltaSeconds}s`

  const deltaMinutes = Math.floor(deltaSeconds / 60)
  if (deltaMinutes < 60) {
    const seconds = deltaSeconds % 60
    return seconds === 0 ? `${deltaMinutes}m` : `${deltaMinutes}m ${seconds}s`
  }

  const deltaHours = Math.floor(deltaMinutes / 60)
  if (deltaHours < 24) {
    const minutes = deltaMinutes % 60
    return minutes === 0 ? `${deltaHours}h` : `${deltaHours}h ${minutes}m`
  }

  const deltaDays = Math.floor(deltaHours / 24)
  const hours = deltaHours % 24
  return hours === 0 ? `${deltaDays}d` : `${deltaDays}d ${hours}h`
}

function buildTaskTable<T>(
  rows: ReadonlyArray<T>,
  columns: ReadonlyArray<TableColumn<T>>,
): string {
  const header = columns
    .map(column => fit(column.label, column.width).padEnd(column.width))
    .join('  ')
  const divider = rule(
    columns.reduce((width, column) => width + column.width, 0) +
      (columns.length - 1) * 2,
  )
  const lines = rows.map(row =>
    columns
      .map(column => fit(column.value(row), column.width).padEnd(column.width))
      .join('  '),
  )

  return [header, divider, ...lines].join('\n')
}

function formatTaskStep(task: DashboardTaskRow): string {
  if (task.currentStepId) return formatStatusLabel(task.currentStepId)
  if (task.runCurrentStateId) return formatStatusLabel(task.runCurrentStateId)
  if (task.lastTraceEvent) return formatStatusLabel(task.lastTraceEvent)
  return '-'
}

function formatTaskDetail(task: DashboardTaskRow): string {
  if (task.lastError) return fit(task.lastError, 34)
  if (task.lastTraceType === 'step') {
    const transition = [
      task.lastTraceEvent ? formatStatusLabel(task.lastTraceEvent) : 'step',
      task.lastTraceReason ? `(${task.lastTraceReason})` : '',
    ]
      .filter(Boolean)
      .join(' ')
    return fit(transition, 34)
  }
  if (task.lastTraceType === 'await_feedback') {
    return fit(task.lastTraceMessage ?? 'Awaiting feedback', 34)
  }
  if (task.lastTraceType === 'completed') {
    return fit(
      `Completed ${formatStatusLabel(task.lastTraceStatus ?? task.state)}`,
      34,
    )
  }
  if (task.runStatus) {
    const lease =
      task.leaseOwner &&
      (task.state === 'in_progress' || task.state === 'running')
        ? ` via ${compactId(task.leaseOwner, 8, 4)}`
        : ''
    return fit(`Run ${formatStatusLabel(task.runStatus)}${lease}`, 34)
  }
  return fit('Waiting for next transition', 34)
}

function formatRecentEventLabel(event: DashboardRecentEvent): string {
  if (event.type === 'step') {
    return [
      'Step',
      event.event ? formatStatusLabel(event.event) : '',
      event.reason ? `(${event.reason})` : '',
    ]
      .filter(Boolean)
      .join(' ')
  }

  if (event.type === 'completed') {
    return `Completed ${formatStatusLabel(event.status ?? event.taskState)}`
  }

  if (event.type === 'await_feedback') {
    return fit(event.message ?? 'Awaiting feedback', 34)
  }

  if (event.type === 'error') {
    return fit(event.message ?? 'Run failed', 34)
  }

  if (event.message) return fit(event.message, 34)
  return formatStatusLabel(event.type)
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '--:--:--'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--:--:--'
  return date.toISOString().slice(11, 19)
}

function compactId(value: string, head = 8, tail = 5): string {
  if (value.length <= head + tail + 1) return value
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

function fit(value: string, width: number): string {
  if (value.length <= width) return value
  if (width <= 1) return value.slice(0, width)
  return `${value.slice(0, Math.max(0, width - 1))}…`
}

function pad(value: string, width: number): string {
  return fit(value, width).padEnd(width)
}

function rule(width: number): string {
  return ''.padEnd(Math.max(0, width), '─')
}
