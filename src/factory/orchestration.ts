type UtilityMetadata = Record<string, unknown>

export type UtilityErrorCode = 'adapter_error' | 'timeout'

export type UtilityError = {
  code: UtilityErrorCode
  message: string
  cause?: unknown
}

export type UtilityResult<TValue> =
  | {
      ok: true
      value: TValue
    }
  | {
      ok: false
      error: UtilityError
    }

type TimeoutConfig = {
  timeoutMs?: number
}

export type InvokeAgentInput = TimeoutConfig & {
  prompt: string
  schema?: Record<string, string>
  model?: string
  metadata?: UtilityMetadata
}

export type InvokeAgentOutput = {
  text: string
  structured?: Record<string, unknown>
  metadata?: UtilityMetadata
}

export type RunCommandInput = TimeoutConfig & {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  metadata?: UtilityMetadata
}

export type RunCommandOutput = {
  exitCode: number
  stdout: string
  stderr: string
  metadata?: UtilityMetadata
}

export type OrchestrationProvider = {
  invokeAgent(input: InvokeAgentInput): Promise<InvokeAgentOutput>
  runCommand(input: RunCommandInput): Promise<RunCommandOutput>
}

class UtilityTimeoutError extends Error {
  constructor(operationName: string, timeoutMs: number) {
    super(`${operationName} timed out after ${timeoutMs}ms`)
    this.name = 'UtilityTimeoutError'
  }
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined
  return Math.floor(timeoutMs)
}

function resolveTimeoutMs(
  inputTimeoutMs: number | undefined,
  optionsTimeoutMs: number | undefined,
): number | undefined {
  return normalizeTimeoutMs(optionsTimeoutMs ?? inputTimeoutMs)
}

function withTimeout<TValue>(
  operationName: string,
  operation: Promise<TValue>,
  timeoutMs: number | undefined,
): Promise<TValue> {
  if (timeoutMs === undefined) return operation

  return new Promise<TValue>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new UtilityTimeoutError(operationName, timeoutMs))
    }, timeoutMs)

    operation
      .then(value => {
        clearTimeout(timeoutId)
        resolve(value)
      })
      .catch(error => {
        clearTimeout(timeoutId)
        reject(error)
      })
  })
}

async function runUtilityOperation<TValue>(
  operationName: string,
  timeoutMs: number | undefined,
  operation: () => Promise<TValue>,
): Promise<UtilityResult<TValue>> {
  try {
    const value = await withTimeout(operationName, operation(), timeoutMs)
    return {ok: true, value}
  } catch (error) {
    if (error instanceof UtilityTimeoutError) {
      return {
        ok: false,
        error: {
          code: 'timeout',
          message: error.message,
          cause: error,
        },
      }
    }

    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: {
        code: 'adapter_error',
        message: `${operationName} adapter failed: ${message}`,
        cause: error,
      },
    }
  }
}

type BoundUtilityOptions = {
  timeoutMs?: number
}

export type OrchestrationUtilities = {
  invokeAgent: (
    input: InvokeAgentInput,
    options?: BoundUtilityOptions,
  ) => Promise<UtilityResult<InvokeAgentOutput>>
  runCommand: (
    input: RunCommandInput,
    options?: BoundUtilityOptions,
  ) => Promise<UtilityResult<RunCommandOutput>>
}

export function createOrchestration(
  provider: OrchestrationProvider,
): OrchestrationUtilities {
  return {
    invokeAgent: (input, options = {}) =>
      runUtilityOperation(
        'invokeAgent',
        resolveTimeoutMs(input.timeoutMs, options.timeoutMs),
        () => provider.invokeAgent(input),
      ),
    runCommand: (input, options = {}) =>
      runUtilityOperation(
        'runCommand',
        resolveTimeoutMs(input.timeoutMs, options.timeoutMs),
        () => provider.runCommand(input),
      ),
  }
}
