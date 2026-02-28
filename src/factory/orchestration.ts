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

export type AskForRepoInput = TimeoutConfig & {
  prompt: string
  metadata?: UtilityMetadata
}

export type AskForRepoOutput = {
  repo: string
  branch?: string
  metadata?: UtilityMetadata
}

export type AskForRepoAdapter = {
  request(input: AskForRepoInput): Promise<AskForRepoOutput>
}

export type InvokeAgentInput = TimeoutConfig & {
  prompt: string
  metadata?: UtilityMetadata
}

export type InvokeAgentOutput = {
  text: string
  metadata?: UtilityMetadata
}

export type InvokeAgentAdapter = {
  invoke(input: InvokeAgentInput): Promise<InvokeAgentOutput>
}

export type AgentSandboxInput = TimeoutConfig & {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  metadata?: UtilityMetadata
}

export type AgentSandboxOutput = {
  exitCode: number
  stdout: string
  stderr: string
  metadata?: UtilityMetadata
}

export type AgentSandboxAdapter = {
  run(input: AgentSandboxInput): Promise<AgentSandboxOutput>
}

export type OrchestrationAdapters = {
  askForRepo: AskForRepoAdapter
  invokeAgent: InvokeAgentAdapter
  agentSandbox: AgentSandboxAdapter
}

type UtilityOptions<TAdapter> = {
  adapter?: TAdapter
  timeoutMs?: number
}

export type AskForRepoOptions = UtilityOptions<AskForRepoAdapter>
export type InvokeAgentOptions = UtilityOptions<InvokeAgentAdapter>
export type AgentSandboxOptions = UtilityOptions<AgentSandboxAdapter>

class UtilityTimeoutError extends Error {
  constructor(operationName: string, timeoutMs: number) {
    super(`${operationName} timed out after ${timeoutMs}ms`)
    this.name = 'UtilityTimeoutError'
  }
}

function missingAdapterError(
  adapterName: keyof OrchestrationAdapters,
): Promise<never> {
  return Promise.reject(new Error(`No adapter configured for ${adapterName}`))
}

export const defaultOrchestrationAdapters: OrchestrationAdapters = {
  askForRepo: {
    request: async () => missingAdapterError('askForRepo'),
  },
  invokeAgent: {
    invoke: async () => missingAdapterError('invokeAgent'),
  },
  agentSandbox: {
    run: async () => missingAdapterError('agentSandbox'),
  },
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

export async function askForRepo(
  input: AskForRepoInput,
  options: AskForRepoOptions = {},
): Promise<UtilityResult<AskForRepoOutput>> {
  const adapter = options.adapter ?? defaultOrchestrationAdapters.askForRepo
  const timeoutMs = resolveTimeoutMs(input.timeoutMs, options.timeoutMs)
  return runUtilityOperation('askForRepo', timeoutMs, () => adapter.request(input))
}

export async function invokeAgent(
  input: InvokeAgentInput,
  options: InvokeAgentOptions = {},
): Promise<UtilityResult<InvokeAgentOutput>> {
  const adapter = options.adapter ?? defaultOrchestrationAdapters.invokeAgent
  const timeoutMs = resolveTimeoutMs(input.timeoutMs, options.timeoutMs)
  return runUtilityOperation('invokeAgent', timeoutMs, () => adapter.invoke(input))
}

export async function agentSandbox(
  input: AgentSandboxInput,
  options: AgentSandboxOptions = {},
): Promise<UtilityResult<AgentSandboxOutput>> {
  const adapter = options.adapter ?? defaultOrchestrationAdapters.agentSandbox
  const timeoutMs = resolveTimeoutMs(input.timeoutMs, options.timeoutMs)
  return runUtilityOperation('agentSandbox', timeoutMs, () => adapter.run(input))
}

type BoundUtilityOptions = {
  timeoutMs?: number
}

export type OrchestrationUtilities = {
  askForRepo: (
    input: AskForRepoInput,
    options?: BoundUtilityOptions,
  ) => Promise<UtilityResult<AskForRepoOutput>>
  invokeAgent: (
    input: InvokeAgentInput,
    options?: BoundUtilityOptions,
  ) => Promise<UtilityResult<InvokeAgentOutput>>
  agentSandbox: (
    input: AgentSandboxInput,
    options?: BoundUtilityOptions,
  ) => Promise<UtilityResult<AgentSandboxOutput>>
}

export function createOrchestrationUtilities(
  adapters: Partial<OrchestrationAdapters> = {},
): OrchestrationUtilities {
  const resolvedAdapters: OrchestrationAdapters = {
    askForRepo: adapters.askForRepo ?? defaultOrchestrationAdapters.askForRepo,
    invokeAgent: adapters.invokeAgent ?? defaultOrchestrationAdapters.invokeAgent,
    agentSandbox: adapters.agentSandbox ?? defaultOrchestrationAdapters.agentSandbox,
  }

  return {
    askForRepo: (input, options = {}) =>
      askForRepo(input, {
        adapter: resolvedAdapters.askForRepo,
        timeoutMs: options.timeoutMs,
      }),
    invokeAgent: (input, options = {}) =>
      invokeAgent(input, {
        adapter: resolvedAdapters.invokeAgent,
        timeoutMs: options.timeoutMs,
      }),
    agentSandbox: (input, options = {}) =>
      agentSandbox(input, {
        adapter: resolvedAdapters.agentSandbox,
        timeoutMs: options.timeoutMs,
      }),
  }
}
