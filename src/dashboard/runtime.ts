import {emitKeypressEvents} from 'node:readline'
import type {DashboardTextView} from './text'
import {buildDashboardTextView} from './text'
import {renderDashboardScreen} from './screen'
import {loadDashboardSnapshot, openDashboardSnapshotSource} from './snapshot'

type DashboardLaunchOptions = {
  configPath?: string
  startDir?: string
  refreshMs?: number
  taskLimit?: number
  footerNote?: () => string | null
  onStop?: () => Promise<void> | void
}

type KeyPress = {
  ctrl?: boolean
  name?: string
}

const DEFAULT_REFRESH_MS = 1_500
const DEFAULT_TASK_LIMIT = 18
const RECENT_EVENT_LIMIT = 10
const WORKFLOW_LIMIT = 5
const ACTIVE_TASK_LIMIT = 8
const ANSI_HOME = '\u001B[H'
const ANSI_CLEAR_SCREEN = '\u001B[2J'
const ANSI_ENTER_ALT_SCREEN = '\u001B[?1049h'
const ANSI_EXIT_ALT_SCREEN = '\u001B[?1049l'
const ANSI_HIDE_CURSOR = '\u001B[?25l'
const ANSI_SHOW_CURSOR = '\u001B[?25h'

export async function launchDashboard(
  options: DashboardLaunchOptions = {},
): Promise<void> {
  const refreshMs = normalizeNumber(options.refreshMs, DEFAULT_REFRESH_MS, 500)
  const taskLimit = normalizeNumber(options.taskLimit, DEFAULT_TASK_LIMIT, 5)
  const source = await openDashboardSnapshotSource({
    configPath: options.configPath,
    startDir: options.startDir ?? process.cwd(),
  })

  assertInteractiveTerminal()

  const input = process.stdin
  const output = process.stdout
  let stopped = false
  let refreshInFlight = false
  let lastFrame = ''
  let resolveStopped: (() => void) | null = null
  let refreshTimer: NodeJS.Timeout | null = null

  const cleanup: Array<() => void> = []

  try {
    const stop = async () => {
      if (stopped) return
      stopped = true
      if (refreshTimer) {
        clearInterval(refreshTimer)
        refreshTimer = null
      }
      await options.onStop?.()
      resolveStopped?.()
    }

    enterDashboardMode(input, output)
    cleanup.push(() => leaveDashboardMode(input, output))

    const onResize = () => {
      void refresh(true)
    }
    output.on('resize', onResize)
    cleanup.push(() => output.off('resize', onResize))

    const onSignal = () => {
      void stop()
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    cleanup.push(() => {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
    })

    const onKeyPress = (_input: string, key: KeyPress) => {
      if ((key.ctrl && key.name === 'c') || key.name === 'q') {
        void stop()
        return
      }

      if (key.name === 'r') {
        void refresh(true)
      }
    }

    input.on('keypress', onKeyPress)
    cleanup.push(() => input.off('keypress', onKeyPress))

    writeFrame(
      output,
      renderDashboardScreen(
        buildLoadingView(
          buildFooterContent(buildControlFooter(), options.footerNote),
        ),
        terminalSize(output),
      ),
    )

    async function refresh(force = false): Promise<void> {
      if (stopped || refreshInFlight) return
      refreshInFlight = true

      try {
        const snapshot = await loadDashboardSnapshot(source, {
          taskLimit,
          activeTaskLimit: ACTIVE_TASK_LIMIT,
          recentEventLimit: RECENT_EVENT_LIMIT,
          workflowLimit: WORKFLOW_LIMIT,
        })
        const view = buildDashboardTextView(snapshot)
        const frame = renderDashboardScreen(
          {
            ...view,
            footer: buildFooterContent(
              buildControlFooter(),
              options.footerNote,
            ),
          },
          terminalSize(output),
        )

        if (force || frame !== lastFrame) {
          writeFrame(output, frame)
          lastFrame = frame
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const frame = renderDashboardScreen(
          buildErrorView(
            message,
            buildFooterContent(buildControlFooter(), options.footerNote),
          ),
          terminalSize(output),
        )

        if (force || frame !== lastFrame) {
          writeFrame(output, frame)
          lastFrame = frame
        }
      } finally {
        refreshInFlight = false
      }
    }

    refreshTimer = setInterval(() => {
      void refresh()
    }, refreshMs)

    await refresh(true)

    await new Promise<void>(resolve => {
      resolveStopped = resolve
    })
  } finally {
    if (refreshTimer) {
      clearInterval(refreshTimer)
    }
    for (const dispose of cleanup.reverse()) {
      dispose()
    }
    source.client.close()
  }
}

export async function runDashboardRuntimeFromArgv(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const args = parseDashboardRuntimeArgv(argv)
  await launchDashboard({
    configPath: args.configPath,
    startDir: process.cwd(),
    refreshMs: args.refreshMs,
    taskLimit: args.taskLimit,
  })
}

function parseDashboardRuntimeArgv(argv: string[]): {
  configPath?: string
  refreshMs?: number
  taskLimit?: number
} {
  return {
    configPath: getArgValue(argv, '--config') ?? undefined,
    refreshMs: parseOptionalNumber(getArgValue(argv, '--refresh-ms')),
    taskLimit: parseOptionalNumber(getArgValue(argv, '--limit')),
  }
}

function getArgValue(argv: string[], flag: string): string | null {
  const inline = argv.find(item => item.startsWith(`${flag}=`))
  if (inline) {
    return inline.slice(flag.length + 1)
  }

  const index = argv.indexOf(flag)
  const next = index >= 0 ? argv[index + 1] : undefined
  if (
    typeof next === 'string' &&
    next.trim().length > 0 &&
    !next.startsWith('--')
  ) {
    return next
  }

  return null
}

function parseOptionalNumber(value: string | null): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeNumber(
  value: number | undefined,
  fallback: number,
  minimum: number,
): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.floor(Number(value)))
}

function buildFooterContent(
  controls: string,
  footerNote: (() => string | null) | undefined,
  base?: string,
): string {
  const segments = [controls]
  if (base && base.trim().length > 0) {
    segments.push(base)
  }
  const note = footerNote?.()
  if (note && note.trim().length > 0) {
    segments.push(note)
  }
  return segments.join('  |  ')
}

function buildLoadingView(footer: string): DashboardTextView {
  return {
    header: 'PIPES DASHBOARD\nLoading runtime state...',
    summary: 'Connecting to the local runtime database.',
    inProgress: 'Loading active tasks...',
    tasks: 'Loading task list...',
    events: 'Loading recent activity...',
    footer,
  }
}

function buildErrorView(message: string, footer: string): DashboardTextView {
  return {
    header: 'PIPES DASHBOARD\nDashboard refresh failed.',
    summary: `Dashboard refresh failed\n\n${message}`,
    inProgress: 'No in-progress task data available.',
    tasks: 'No task rows available.',
    events: 'No recent activity available.',
    footer,
  }
}

function buildControlFooter(): string {
  return 'q quit  |  r refresh'
}

function terminalSize(output: NodeJS.WriteStream): {
  columns: number
  rows: number
} {
  return {
    columns: output.columns ?? 120,
    rows: output.rows ?? 34,
  }
}

function assertInteractiveTerminal(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'The start dashboard requires an interactive TTY. Use `pipes tick` for non-interactive execution.',
    )
  }
}

function enterDashboardMode(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
): void {
  emitKeypressEvents(input)
  if (typeof input.setRawMode === 'function') {
    input.setRawMode(true)
  }
  input.resume()
  output.write(`${ANSI_ENTER_ALT_SCREEN}${ANSI_HIDE_CURSOR}`)
}

function leaveDashboardMode(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
): void {
  if (typeof input.setRawMode === 'function') {
    input.setRawMode(false)
  }
  input.pause()
  output.write(`${ANSI_SHOW_CURSOR}${ANSI_EXIT_ALT_SCREEN}`)
}

function writeFrame(output: NodeJS.WriteStream, frame: string): void {
  output.write(`${ANSI_HOME}${ANSI_CLEAR_SCREEN}${frame}\n`)
}

if (import.meta.main) {
  await runDashboardRuntimeFromArgv()
}
