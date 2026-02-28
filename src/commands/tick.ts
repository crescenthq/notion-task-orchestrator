import {defineCommand} from 'citty'
import {appendFile} from 'node:fs/promises'
import {openApp} from '../app/context'
import {syncNotionBoards} from './notion'

const DEFAULT_LOOP_DELAY_MS = 2_000
const BACKOFF_MAX_MS = 15_000
const BACKOFF_JITTER_MAX_MS = 250

type TickArgs = {
  board?: string
  factory?: string
  config?: string
  maxTransitionsPerTick?: string
  leaseMs?: string
  leaseMode?: string
  workerId?: string
  loop?: boolean
  intervalMs?: string
}

type TickExecutionOptions = {
  boardId?: string
  factoryId?: string
  configPath?: string
  startDir: string
  maxTransitionsPerTick?: number
  leaseMs?: number
  leaseMode: 'strict' | 'best-effort'
  workerId?: string
  loop: boolean
  loopDelayMs: number
}

type TickRuntimeLogger = {
  runtimeLog: (line: string) => Promise<void>
  errorLog: (line: string) => Promise<void>
}

type TickLoopDeps = {
  runTick: (
    options: Omit<TickExecutionOptions, 'loop' | 'loopDelayMs'>,
  ) => Promise<void>
  createLogger: (options: {
    configPath?: string
    startDir: string
  }) => Promise<TickRuntimeLogger>
  random: () => number
  signalSource: Pick<NodeJS.Process, 'on' | 'off'>
}

const defaultTickLoopDeps: TickLoopDeps = {
  runTick: async options => {
    await syncNotionBoards({
      boardId: options.boardId,
      factoryId: options.factoryId,
      configPath: options.configPath,
      startDir: options.startDir,
      runQueued: true,
      maxTransitionsPerTick: options.maxTransitionsPerTick,
      leaseMs: options.leaseMs,
      leaseMode: options.leaseMode,
      workerId: options.workerId,
    })
  },
  createLogger: async options => {
    const {paths} = await openApp({
      configPath: options.configPath,
      startDir: options.startDir,
    })
    return {
      runtimeLog: async line => {
        await appendFile(
          paths.runtimeLog,
          `${new Date().toISOString()} ${line}\n`,
          'utf8',
        )
      },
      errorLog: async line => {
        await appendFile(
          paths.errorsLog,
          `${new Date().toISOString()} ${line}\n`,
          'utf8',
        )
      },
    }
  },
  random: () => Math.random(),
  signalSource: process,
}

function parseTickExecutionOptions(args: TickArgs): TickExecutionOptions {
  const maxTransitionsPerTick = args.maxTransitionsPerTick
    ? Number.parseInt(String(args.maxTransitionsPerTick), 10)
    : undefined
  const leaseMs = args.leaseMs
    ? Number.parseInt(String(args.leaseMs), 10)
    : undefined
  const intervalMs = args.intervalMs
    ? Number.parseInt(String(args.intervalMs), 10)
    : undefined

  return {
    boardId: args.board ? String(args.board) : undefined,
    factoryId: args.factory ? String(args.factory) : undefined,
    configPath: args.config ? String(args.config) : undefined,
    startDir: process.cwd(),
    maxTransitionsPerTick: Number.isFinite(maxTransitionsPerTick)
      ? maxTransitionsPerTick
      : undefined,
    leaseMs: Number.isFinite(leaseMs) ? leaseMs : undefined,
    leaseMode: args.leaseMode === 'strict' ? 'strict' : 'best-effort',
    workerId: args.workerId ? String(args.workerId) : undefined,
    loop: Boolean(args.loop),
    loopDelayMs:
      Number.isFinite(intervalMs) && Number(intervalMs) >= 0
        ? Math.floor(Number(intervalMs))
        : DEFAULT_LOOP_DELAY_MS,
  }
}

function isRetryableNotionApiError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const statusMatch = error.message.match(/\((\d{3})\)/)
  if (!statusMatch) {
    return false
  }

  const status = Number.parseInt(statusMatch[1] ?? '', 10)
  return status === 429 || (status >= 500 && status <= 599)
}

function computeBackoffMs(attempt: number, random: () => number): number {
  const boundedAttempt = Math.max(1, Math.floor(attempt))
  const exponentMs = DEFAULT_LOOP_DELAY_MS * 2 ** (boundedAttempt - 1)
  const baseMs = Math.min(exponentMs, BACKOFF_MAX_MS)
  const jitterMs = Math.floor(
    Math.max(0, Math.min(1, random())) * (BACKOFF_JITTER_MAX_MS + 1),
  )
  return baseMs + jitterMs
}

export async function executeTick(
  options: TickExecutionOptions,
  deps: TickLoopDeps = defaultTickLoopDeps,
): Promise<void> {
  const logger = await deps.createLogger({
    configPath: options.configPath,
    startDir: options.startDir,
  })

  if (!options.loop) {
    await deps.runTick(options)
    return
  }

  let stopRequested = false
  let cycleCount = 0
  let retryAttempt = 0
  let pendingTimer: NodeJS.Timeout | null = null
  let resolvePendingWait: (() => void) | null = null

  const onSignal = (signal: NodeJS.Signals) => {
    if (stopRequested) {
      return
    }
    stopRequested = true
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
    if (resolvePendingWait) {
      resolvePendingWait()
      resolvePendingWait = null
    }
    void logger.runtimeLog(`tick loop termination requested signal=${signal}`)
  }

  const waitMs = async (ms: number): Promise<void> => {
    if (ms <= 0 || stopRequested) {
      return
    }

    await new Promise<void>(resolve => {
      resolvePendingWait = resolve
      pendingTimer = setTimeout(() => {
        pendingTimer = null
        resolvePendingWait = null
        resolve()
      }, ms)
    })
  }

  deps.signalSource.on('SIGINT', onSignal)
  deps.signalSource.on('SIGTERM', onSignal)

  await logger.runtimeLog(`tick loop started delay_ms=${options.loopDelayMs}`)

  try {
    while (!stopRequested) {
      cycleCount += 1
      await logger.runtimeLog(`tick cycle start index=${cycleCount}`)

      try {
        await deps.runTick(options)
        retryAttempt = 0
        await logger.runtimeLog(`tick cycle complete index=${cycleCount}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await logger.errorLog(
          `tick cycle failed index=${cycleCount} error=${message}`,
        )

        if (!isRetryableNotionApiError(error)) {
          await logger.runtimeLog(
            `tick loop aborting on non-retryable error index=${cycleCount}`,
          )
          throw error
        }

        retryAttempt += 1
        const backoffMs = computeBackoffMs(retryAttempt, deps.random)
        await logger.runtimeLog(
          `tick cycle retryable error index=${cycleCount} backoff_attempt=${retryAttempt} backoff_ms=${backoffMs}`,
        )
        await waitMs(backoffMs)
        continue
      }

      if (stopRequested) {
        break
      }

      await logger.runtimeLog(
        `tick cycle sleep index=${cycleCount} delay_ms=${options.loopDelayMs}`,
      )
      await waitMs(options.loopDelayMs)
    }
  } finally {
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
    resolvePendingWait = null
    deps.signalSource.off('SIGINT', onSignal)
    deps.signalSource.off('SIGTERM', onSignal)
    await logger.runtimeLog(`tick loop stopped cycles=${cycleCount}`)
  }
}

export const tickCmd = defineCommand({
  meta: {
    name: 'tick',
    description: '[common] Run one orchestration tick across queued tasks',
  },
  args: {
    board: {type: 'string', required: false},
    factory: {type: 'string', required: false},
    config: {type: 'string', required: false},
    loop: {type: 'boolean', required: false},
    intervalMs: {type: 'string', required: false, alias: 'interval-ms'},
    maxTransitionsPerTick: {
      type: 'string',
      required: false,
      alias: 'max-transitions-per-tick',
    },
    leaseMs: {type: 'string', required: false, alias: 'lease-ms'},
    leaseMode: {type: 'string', required: false, alias: 'lease-mode'},
    workerId: {type: 'string', required: false, alias: 'worker-id'},
  },
  async run({args}) {
    await executeTick(parseTickExecutionOptions(args))
  },
})
