import {EventEmitter} from 'node:events'
import {executeTick, parseTickExecutionOptions} from '../commands/tick'
import {launchDashboard} from '../dashboard/runtime'

type StartSessionOptions = {
  pipe?: string
  configPath?: string
  intervalMs?: string
  refreshMs?: string
  limit?: string
  maxTransitionsPerTick?: string
  runConcurrency?: string
  leaseMs?: string
  leaseMode?: string
  workerId?: string
}

export async function launchStartSession(
  options: StartSessionOptions = {},
): Promise<void> {
  assertInteractiveStartSession()

  const signalEmitter = new EventEmitter()
  const signalSource = signalEmitter as unknown as Pick<
    NodeJS.Process,
    'on' | 'off'
  >
  const tickOptions = {
    ...parseTickExecutionOptions({
      pipe: options.pipe,
      config: options.configPath,
      intervalMs: options.intervalMs,
      maxTransitionsPerTick: options.maxTransitionsPerTick,
      runConcurrency: options.runConcurrency,
      leaseMs: options.leaseMs,
      leaseMode: options.leaseMode,
      workerId: options.workerId,
      loop: true,
    }),
    loop: true,
  }

  let workerFailure: Error | null = null
  let workerCrashed = false
  let workerStopRequested = false
  let workerNote = `loop ${tickOptions.loopDelayMs}ms`

  const workerPromise = executeTick(tickOptions, {
    signalSource,
    captureConsoleOutput: true,
  }).catch(error => {
    workerCrashed = true
    workerFailure = error instanceof Error ? error : new Error(String(error))
    workerNote = `failed: ${workerFailure.message}`
  })

  const stopWorker = async () => {
    if (workerStopRequested) return
    workerStopRequested = true
    workerNote = 'stopping'
    signalEmitter.emit('SIGTERM', 'SIGTERM')
    await workerPromise
    if (!workerFailure) {
      workerNote = 'stopped'
    }
  }

  try {
    await launchDashboard({
      configPath: options.configPath,
      startDir: process.cwd(),
      refreshMs: parseOptionalNumber(options.refreshMs),
      taskLimit: parseOptionalNumber(options.limit),
      footerNote: () => workerNote,
      onStop: stopWorker,
    })
  } catch (error) {
    await stopWorker()
    throw error
  }

  await workerPromise

  if (workerFailure && workerCrashed) {
    throw workerFailure
  }
}

export async function runStartRuntimeFromArgv(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  await launchStartSession(parseStartRuntimeArgv(argv))
}

function parseStartRuntimeArgv(argv: string[]): StartSessionOptions {
  return {
    pipe: getArgValue(argv, '--pipe') ?? undefined,
    configPath: getArgValue(argv, '--config') ?? undefined,
    intervalMs: getArgValue(argv, '--interval-ms') ?? undefined,
    refreshMs: getArgValue(argv, '--refresh-ms') ?? undefined,
    limit: getArgValue(argv, '--limit') ?? undefined,
    maxTransitionsPerTick:
      getArgValue(argv, '--max-transitions-per-tick') ?? undefined,
    runConcurrency: getArgValue(argv, '--run-concurrency') ?? undefined,
    leaseMs: getArgValue(argv, '--lease-ms') ?? undefined,
    leaseMode: getArgValue(argv, '--lease-mode') ?? undefined,
    workerId: getArgValue(argv, '--worker-id') ?? undefined,
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

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function assertInteractiveStartSession(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'The start dashboard requires an interactive TTY. Use `pipes tick` for non-interactive execution.',
    )
  }
}

if (import.meta.main) {
  await runStartRuntimeFromArgv()
}
