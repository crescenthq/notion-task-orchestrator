export type KnownAgentErrorCode = 'timeout' | 'aborted' | 'call_error'

export type AgentErrorCode = KnownAgentErrorCode | (string & {})

export type AgentError<TCode extends string = AgentErrorCode> = {
  code: TCode
  message: string
  cause?: unknown
}

export type AgentResult<TValue, TCode extends string = AgentErrorCode> =
  | {
      ok: true
      value: TValue
    }
  | {
      ok: false
      error: AgentError<TCode>
    }

export type RetryPolicy = {
  attempts: number
  delay?: number | ((attempt: number, error: AgentError) => number)
}

export type AgentCallContext = {
  signal: AbortSignal
  attempt: number
}

export type AgentErrorMapContext<TInput> = {
  id: string
  input: TInput
  attempt: number
}

export type AgentErrorMapper<TInput, TCode extends string = AgentErrorCode> = (
  error: unknown,
  ctx: AgentErrorMapContext<TInput>,
) => AgentError<TCode>

export type DefineAgentOptions<
  TInput,
  TOutput,
  TCode extends string = AgentErrorCode,
> = {
  id: string
  timeoutMs?: number
  retry?: RetryPolicy
  call: (input: TInput, ctx: AgentCallContext) => Promise<TOutput>
  mapError?: AgentErrorMapper<TInput, TCode>
}

export type AgentInvokeOptions = {
  timeoutMs?: number
  signal?: AbortSignal
}

export type Agent<TInput, TOutput, TCode extends string = AgentErrorCode> = {
  id: string
  invoke: (
    input: TInput,
    options?: AgentInvokeOptions,
  ) => Promise<AgentResult<TOutput, TCode>>
}

class AgentTimeoutError extends Error {
  constructor(agentId: string, attempt: number, timeoutMs: number) {
    super(`${agentId} timed out on attempt ${attempt} after ${timeoutMs}ms`)
    this.name = 'AgentTimeoutError'
  }
}

class AgentAbortedError extends Error {
  constructor(agentId: string, attempt: number, reason?: unknown) {
    const reasonMessage =
      reason === undefined
        ? ''
        : `: ${reason instanceof Error ? reason.message : String(reason)}`
    super(`${agentId} aborted on attempt ${attempt}${reasonMessage}`)
    this.name = 'AgentAbortedError'
  }
}

function isAbortLikeError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (typeof DOMException !== 'undefined' &&
      error instanceof DOMException &&
      error.name === 'AbortError')
  )
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined
  return Math.floor(timeoutMs)
}

function normalizeDelayMs(delayMs: number): number {
  if (!Number.isFinite(delayMs) || delayMs < 0) return 0
  return Math.floor(delayMs)
}

function normalizeRetryPolicy(retry: RetryPolicy | undefined): RetryPolicy {
  if (!retry) {
    return {
      attempts: 1,
      delay: 0,
    }
  }

  const attempts =
    Number.isFinite(retry.attempts) && retry.attempts > 0
      ? Math.floor(retry.attempts)
      : 1

  const delay =
    typeof retry.delay === 'function'
      ? retry.delay
      : normalizeDelayMs(
          typeof retry.delay === 'number' ? retry.delay : Number.NaN,
        )

  return {
    attempts,
    delay,
  }
}

function resolveTimeoutMs(
  invokeTimeoutMs: number | undefined,
  defaultTimeoutMs: number | undefined,
): number | undefined {
  return normalizeTimeoutMs(invokeTimeoutMs ?? defaultTimeoutMs)
}

function attachAbort(signal: AbortSignal, onAbort: () => void): () => void {
  if (signal.aborted) {
    onAbort()
    return () => {}
  }

  signal.addEventListener('abort', onAbort, {once: true})
  return () => {
    signal.removeEventListener('abort', onAbort)
  }
}

function mapErrorWithDefault<TInput, TCode extends string>(
  options: DefineAgentOptions<TInput, unknown, TCode>,
  error: unknown,
  ctx: AgentErrorMapContext<TInput>,
): AgentError<TCode> {
  if (!options.mapError) {
    return defaultMapAgentError(error, ctx) as AgentError<TCode>
  }

  try {
    return options.mapError(error, ctx)
  } catch (mapErrorFailure) {
    return defaultMapAgentError(mapErrorFailure, ctx) as AgentError<TCode>
  }
}

async function runAttempt<TInput, TOutput, TCode extends string>(
  options: DefineAgentOptions<TInput, TOutput, TCode>,
  input: TInput,
  attempt: number,
  timeoutMs: number | undefined,
  externalSignal: AbortSignal | undefined,
): Promise<TOutput> {
  const controller = new AbortController()
  let timeoutTriggered = false

  const cleanupExternalAbort = externalSignal
    ? attachAbort(externalSignal, () => {
        controller.abort(externalSignal.reason)
      })
    : () => {}

  let timeoutId: ReturnType<typeof setTimeout> | undefined

  const timeoutPromise =
    timeoutMs === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(() => {
            const timeoutError = new AgentTimeoutError(
              options.id,
              attempt,
              timeoutMs,
            )
            timeoutTriggered = true
            reject(timeoutError)
            controller.abort(timeoutError)
          }, timeoutMs)
        })

  let rejectAbort: ((reason?: unknown) => void) | undefined
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })

  const cleanupAttemptAbort = attachAbort(controller.signal, () => {
    if (timeoutTriggered) return
    rejectAbort?.(
      new AgentAbortedError(options.id, attempt, controller.signal.reason),
    )
  })

  try {
    const operation = options.call(input, {
      signal: controller.signal,
      attempt,
    })

    if (!timeoutPromise) {
      return await Promise.race([operation, abortPromise])
    }

    return await Promise.race([operation, timeoutPromise, abortPromise])
  } finally {
    cleanupAttemptAbort()
    cleanupExternalAbort()
    if (timeoutId) clearTimeout(timeoutId)
  }
}

function resolveRetryDelayMs(options: {
  delay: RetryPolicy['delay']
  attempt: number
  error: AgentError
}): number {
  const {delay, attempt, error} = options

  if (typeof delay === 'function') {
    try {
      return normalizeDelayMs(delay(attempt, error))
    } catch {
      return 0
    }
  }

  return normalizeDelayMs(typeof delay === 'number' ? delay : Number.NaN)
}

async function waitDelay(options: {
  agentId: string
  delayMs: number
  attempt: number
  signal: AbortSignal | undefined
}): Promise<void> {
  const {agentId, delayMs, attempt, signal} = options

  if (delayMs <= 0) return

  if (signal?.aborted) {
    throw new AgentAbortedError(agentId, attempt, signal.reason)
  }

  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup()
      resolve()
    }, delayMs)

    let cleanupAbort = () => {}
    const cleanup = () => {
      cleanupAbort()
    }

    cleanupAbort = signal
      ? attachAbort(signal, () => {
          clearTimeout(timeoutId)
          cleanup()
          reject(new AgentAbortedError(agentId, attempt, signal.reason))
        })
      : () => {}
  })
}

export function defaultMapAgentError<TInput>(
  error: unknown,
  ctx: AgentErrorMapContext<TInput>,
): AgentError<KnownAgentErrorCode> {
  if (error instanceof AgentTimeoutError) {
    return {
      code: 'timeout',
      message: error.message,
      cause: error,
    }
  }

  if (error instanceof AgentAbortedError || isAbortLikeError(error)) {
    return {
      code: 'aborted',
      message: error instanceof Error ? error.message : `${ctx.id} aborted`,
      cause: error,
    }
  }

  const message = error instanceof Error ? error.message : String(error)
  return {
    code: 'call_error',
    message: `${ctx.id} call failed on attempt ${ctx.attempt}: ${message}`,
    cause: error,
  }
}

export function defineAgent<
  TInput,
  TOutput,
  TCode extends string = AgentErrorCode,
>(
  options: DefineAgentOptions<TInput, TOutput, TCode>,
): Agent<TInput, TOutput, TCode> {
  const retryPolicy = normalizeRetryPolicy(options.retry)
  const defaultTimeoutMs = normalizeTimeoutMs(options.timeoutMs)

  return {
    id: options.id,
    async invoke(input, invokeOptions = {}) {
      const timeoutMs = resolveTimeoutMs(
        invokeOptions.timeoutMs,
        defaultTimeoutMs,
      )

      for (let attempt = 1; attempt <= retryPolicy.attempts; attempt += 1) {
        try {
          const value = await runAttempt(
            options,
            input,
            attempt,
            timeoutMs,
            invokeOptions.signal,
          )
          return {
            ok: true,
            value,
          }
        } catch (error) {
          const mappedError = mapErrorWithDefault(options, error, {
            id: options.id,
            input,
            attempt,
          })

          if (attempt === retryPolicy.attempts) {
            return {
              ok: false,
              error: mappedError,
            }
          }

          const delayMs = resolveRetryDelayMs({
            delay: retryPolicy.delay,
            attempt,
            error: mappedError,
          })

          try {
            await waitDelay({
              agentId: options.id,
              delayMs,
              attempt,
              signal: invokeOptions.signal,
            })
          } catch (delayError) {
            return {
              ok: false,
              error: mapErrorWithDefault(options, delayError, {
                id: options.id,
                input,
                attempt,
              }),
            }
          }
        }
      }

      return {
        ok: false,
        error: mapErrorWithDefault(
          options,
          new Error('unreachable retry state'),
          {
            id: options.id,
            input,
            attempt: retryPolicy.attempts,
          },
        ),
      }
    },
  }
}
