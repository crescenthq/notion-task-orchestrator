import {afterEach, describe, expect, it, vi} from 'vitest'
import {defineAgent} from './orchestration'

describe('defineAgent core contract', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns ok results and passes attempt + signal into call', async () => {
    const call = vi.fn(
      async (
        _input: {prompt: string},
        ctx: {attempt: number; signal: AbortSignal},
      ) => {
        expect(ctx.signal.aborted).toBe(false)
        return {text: `attempt-${ctx.attempt}`}
      },
    )

    const agent = defineAgent<{prompt: string}, {text: string}>({
      id: 'coder',
      call,
    })

    const result = await agent.invoke({prompt: 'plan'})

    expect(result).toEqual({
      ok: true,
      value: {text: 'attempt-1'},
    })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('uses explicit default error normalization when mapError is omitted', async () => {
    const agent = defineAgent<{prompt: string}, {text: string}>({
      id: 'coder',
      call: async () => {
        throw new Error('provider unavailable')
      },
    })

    const result = await agent.invoke({prompt: 'draft'})

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('Expected defineAgent to fail')
    }

    expect(result.error.code).toBe('call_error')
    expect(result.error.message).toBe(
      'coder call failed on attempt 1: provider unavailable',
    )
  })

  it('cleans up timeout when call throws synchronously', async () => {
    vi.useFakeTimers()

    const agent = defineAgent<{prompt: string}, {text: string}>({
      id: 'coder',
      timeoutMs: 5,
      call: () => {
        throw new Error('sync')
      },
    })

    const result = await agent.invoke({prompt: 'draft'})

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('Expected defineAgent to fail')
    }

    expect(result.error.code).toBe('call_error')
    expect(result.error.message).toBe('coder call failed on attempt 1: sync')

    await vi.advanceTimersByTimeAsync(25)
  })

  it('supports custom mapError codes with extensible string typing', async () => {
    type CustomCode = 'http_error' | (string & {})

    const agent = defineAgent<{prompt: string}, {text: string}, CustomCode>({
      id: 'coder',
      call: async () => {
        throw new Error('HTTP 503')
      },
      mapError: error => ({
        code: 'http_error',
        message: error instanceof Error ? error.message : 'unknown',
        cause: error,
      }),
    })

    const result = await agent.invoke({prompt: 'draft'})

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'http_error',
        message: 'HTTP 503',
        cause: expect.any(Error),
      },
    })
  })

  it('treats timeoutMs as per-attempt and retries with next attempt', async () => {
    vi.useFakeTimers()

    const call = vi.fn(
      async (
        _input: {prompt: string},
        ctx: {attempt: number; signal: AbortSignal},
      ) => {
        if (ctx.attempt === 1) {
          return await new Promise<{text: string}>(() => {
            // Intentionally unresolved; timeout must cut this attempt.
          })
        }

        return {text: `attempt-${ctx.attempt}`}
      },
    )

    const agent = defineAgent<{prompt: string}, {text: string}>({
      id: 'coder',
      timeoutMs: 50,
      retry: {attempts: 2, backoffMs: 0},
      call,
    })

    const resultPromise = agent.invoke({prompt: 'retry me'})

    await vi.advanceTimersByTimeAsync(50)
    const result = await resultPromise

    expect(call).toHaveBeenCalledTimes(2)
    expect(result).toEqual({
      ok: true,
      value: {text: 'attempt-2'},
    })
  })

  it('applies retry backoff deterministically between attempts', async () => {
    vi.useFakeTimers()

    const call = vi.fn(
      async (
        _input: {prompt: string},
        ctx: {attempt: number; signal: AbortSignal},
      ) => {
        if (ctx.attempt < 3) {
          throw new Error(`failure-${ctx.attempt}`)
        }

        return {text: 'done'}
      },
    )

    const agent = defineAgent<{prompt: string}, {text: string}>({
      id: 'coder',
      retry: {attempts: 3, backoffMs: 25},
      call,
    })

    const resultPromise = agent.invoke({prompt: 'retry me'})

    await Promise.resolve()
    expect(call).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(24)
    expect(call).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(call).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(25)
    const result = await resultPromise

    expect(call).toHaveBeenCalledTimes(3)
    expect(result).toEqual({
      ok: true,
      value: {text: 'done'},
    })
  })

  it('propagates timeout abort into the call signal', async () => {
    vi.useFakeTimers()

    const abortedSignals: boolean[] = []
    const agent = defineAgent<{prompt: string}, {text: string}>({
      id: 'coder',
      timeoutMs: 10,
      call: async (_input, ctx) =>
        await new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener(
            'abort',
            () => {
              abortedSignals.push(ctx.signal.aborted)
              reject(ctx.signal.reason ?? new Error('aborted'))
            },
            {once: true},
          )
        }),
    })

    const resultPromise = agent.invoke({prompt: 'x'})
    await vi.advanceTimersByTimeAsync(10)
    const result = await resultPromise

    expect(abortedSignals).toEqual([true])
    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('Expected timeout failure')
    }

    expect(result.error.code).toBe('timeout')
    expect(result.error.message).toContain('timed out on attempt 1')
  })
})
