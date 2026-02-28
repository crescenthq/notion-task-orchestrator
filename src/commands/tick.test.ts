import {EventEmitter} from 'node:events'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {executeTick} from './tick'

type MemoryLogger = {
  runtimeLines: string[]
  errorLines: string[]
}

describe('tick command loop execution', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs one cycle in one-shot mode by default', async () => {
    const logger = createMemoryLogger()
    let runCalls = 0

    await executeTick(
      {
        startDir: process.cwd(),
        leaseMode: 'strict',
        loop: false,
        loopDelayMs: 2_000,
      },
      {
        runTick: async () => {
          runCalls += 1
        },
        createLogger: async () => ({
          runtimeLog: async line => {
            logger.runtimeLines.push(line)
          },
          errorLog: async line => {
            logger.errorLines.push(line)
          },
        }),
        random: () => 0,
        signalSource: new EventEmitter() as unknown as Pick<
          NodeJS.Process,
          'on' | 'off'
        >,
      },
    )

    expect(runCalls).toBe(1)
    expect(logger.runtimeLines).toEqual([])
    expect(logger.errorLines).toEqual([])
  })

  it('applies exponential backoff with cap for retryable Notion API errors', async () => {
    vi.useFakeTimers()
    const logger = createMemoryLogger()
    const signalSource = new EventEmitter()
    let runCalls = 0

    const execution = executeTick(
      {
        startDir: process.cwd(),
        leaseMode: 'strict',
        loop: true,
        loopDelayMs: 2_000,
      },
      {
        runTick: async () => {
          runCalls += 1
          if (runCalls === 1)
            throw new Error('Notion query failed (429): limited')
          if (runCalls === 2)
            throw new Error('Notion query failed (503): unavailable')
          if (runCalls === 3)
            throw new Error('Notion query failed (502): bad gateway')
          signalSource.emit('SIGTERM', 'SIGTERM')
          throw new Error('Notion query failed (500): temporary')
        },
        createLogger: async () => ({
          runtimeLog: async line => {
            logger.runtimeLines.push(line)
          },
          errorLog: async line => {
            logger.errorLines.push(line)
          },
        }),
        random: () => 0,
        signalSource: signalSource as unknown as Pick<
          NodeJS.Process,
          'on' | 'off'
        >,
      },
    )

    await vi.advanceTimersByTimeAsync(2_000)
    await vi.advanceTimersByTimeAsync(4_000)
    await vi.advanceTimersByTimeAsync(8_000)
    await execution

    expect(runCalls).toBe(4)
    const backoffLines = logger.runtimeLines.filter(line =>
      line.includes('tick cycle retryable error'),
    )
    expect(backoffLines[0]).toContain('backoff_ms=2000')
    expect(backoffLines[1]).toContain('backoff_ms=4000')
    expect(backoffLines[2]).toContain('backoff_ms=8000')
    expect(backoffLines[3]).toContain('backoff_ms=15000')
    expect(
      logger.runtimeLines.some(line =>
        line.includes('tick loop stopped cycles=4'),
      ),
    ).toBe(true)
  })

  it('completes the current cycle after SIGINT and exits without scheduling a new cycle', async () => {
    vi.useFakeTimers()
    const logger = createMemoryLogger()
    const signalSource = new EventEmitter()
    let runCalls = 0
    let resolveCycle: () => void = () => {}
    const cycleInFlight = new Promise<void>(resolve => {
      resolveCycle = resolve
    })

    const execution = executeTick(
      {
        startDir: process.cwd(),
        leaseMode: 'strict',
        loop: true,
        loopDelayMs: 2_000,
      },
      {
        runTick: async () => {
          runCalls += 1
          await cycleInFlight
        },
        createLogger: async () => ({
          runtimeLog: async line => {
            logger.runtimeLines.push(line)
          },
          errorLog: async line => {
            logger.errorLines.push(line)
          },
        }),
        random: () => 0,
        signalSource: signalSource as unknown as Pick<
          NodeJS.Process,
          'on' | 'off'
        >,
      },
    )

    await vi.advanceTimersByTimeAsync(0)
    signalSource.emit('SIGINT', 'SIGINT')
    resolveCycle()
    await execution

    expect(runCalls).toBe(1)
    expect(
      logger.runtimeLines.some(line =>
        line.includes('termination requested signal=SIGINT'),
      ),
    ).toBe(true)
    expect(
      logger.runtimeLines.some(line =>
        line.includes('tick loop stopped cycles=1'),
      ),
    ).toBe(true)
  })
})

function createMemoryLogger(): MemoryLogger {
  return {runtimeLines: [], errorLines: []}
}
