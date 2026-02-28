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

export type AskForRepoService = {
  askForRepo(input: AskForRepoInput): Promise<AskForRepoOutput>
}

export type InvokeAgentService = {
  invokeAgent(input: InvokeAgentInput): Promise<InvokeAgentOutput>
}

export type AgentSandboxService = {
  agentSandbox(input: AgentSandboxInput): Promise<AgentSandboxOutput>
}

export type OrchestrationServices = AskForRepoService &
  InvokeAgentService &
  AgentSandboxService

export type Effect<TServices, TValue> = (
  services: TServices,
) => Promise<TValue> | TValue

export type Layer<TServices> = {
  build(): Promise<TServices> | TServices
}

export type OrchestrationEffect<TValue> = Effect<OrchestrationServices, TValue>

export type OrchestrationLayer = Layer<OrchestrationServices>

type UtilityOptions<TAdapter> = {
  adapter?: TAdapter
  layer?: OrchestrationLayer
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

function buildServices(
  adapters: Partial<OrchestrationAdapters> = {},
): OrchestrationServices {
  const resolvedAdapters: OrchestrationAdapters = {
    askForRepo: adapters.askForRepo ?? defaultOrchestrationAdapters.askForRepo,
    invokeAgent: adapters.invokeAgent ?? defaultOrchestrationAdapters.invokeAgent,
    agentSandbox: adapters.agentSandbox ?? defaultOrchestrationAdapters.agentSandbox,
  }

  return {
    askForRepo: input => resolvedAdapters.askForRepo.request(input),
    invokeAgent: input => resolvedAdapters.invokeAgent.invoke(input),
    agentSandbox: input => resolvedAdapters.agentSandbox.run(input),
  }
}

export function createOrchestrationLayer(
  adapters: Partial<OrchestrationAdapters> = {},
): OrchestrationLayer {
  return {
    build: () => buildServices(adapters),
  }
}

export const defaultOrchestrationLayer = createOrchestrationLayer()

type OrchestrationServiceOverrides = Partial<OrchestrationServices>

export function createOrchestrationTestLayer(
  overrides: OrchestrationServiceOverrides = {},
  baseLayer: OrchestrationLayer = defaultOrchestrationLayer,
): OrchestrationLayer {
  return {
    build: async () => {
      const base = await baseLayer.build()
      return {
        ...base,
        ...overrides,
      }
    },
  }
}

function hasServiceOverrides(overrides: OrchestrationServiceOverrides): boolean {
  return Boolean(
    overrides.askForRepo || overrides.invokeAgent || overrides.agentSandbox,
  )
}

function resolveLayer(
  layer: OrchestrationLayer | undefined,
  overrides: OrchestrationServiceOverrides,
): OrchestrationLayer {
  const baseLayer = layer ?? defaultOrchestrationLayer
  if (!hasServiceOverrides(overrides)) {
    return baseLayer
  }

  return createOrchestrationTestLayer(overrides, baseLayer)
}

export async function runOrchestrationEffect<TValue>(
  effect: OrchestrationEffect<TValue>,
  layer: OrchestrationLayer = defaultOrchestrationLayer,
): Promise<TValue> {
  const services = await layer.build()
  return effect(services)
}

type UtilityExecutionOptions = {
  timeoutMs?: number
}

export function askForRepoEffect(
  input: AskForRepoInput,
  options: UtilityExecutionOptions = {},
): OrchestrationEffect<UtilityResult<AskForRepoOutput>> {
  const timeoutMs = resolveTimeoutMs(input.timeoutMs, options.timeoutMs)
  return services =>
    runUtilityOperation('askForRepo', timeoutMs, () =>
      services.askForRepo(input),
    )
}

export function invokeAgentEffect(
  input: InvokeAgentInput,
  options: UtilityExecutionOptions = {},
): OrchestrationEffect<UtilityResult<InvokeAgentOutput>> {
  const timeoutMs = resolveTimeoutMs(input.timeoutMs, options.timeoutMs)
  return services =>
    runUtilityOperation('invokeAgent', timeoutMs, () =>
      services.invokeAgent(input),
    )
}

export function agentSandboxEffect(
  input: AgentSandboxInput,
  options: UtilityExecutionOptions = {},
): OrchestrationEffect<UtilityResult<AgentSandboxOutput>> {
  const timeoutMs = resolveTimeoutMs(input.timeoutMs, options.timeoutMs)
  return services =>
    runUtilityOperation('agentSandbox', timeoutMs, () =>
      services.agentSandbox(input),
    )
}

export async function askForRepo(
  input: AskForRepoInput,
  options: AskForRepoOptions = {},
): Promise<UtilityResult<AskForRepoOutput>> {
  const adapter = options.adapter
  const layer = resolveLayer(
    options.layer,
    adapter
      ? {
          askForRepo: askInput => adapter.request(askInput),
        }
      : {},
  )

  return runOrchestrationEffect(
    askForRepoEffect(input, {timeoutMs: options.timeoutMs}),
    layer,
  )
}

export async function invokeAgent(
  input: InvokeAgentInput,
  options: InvokeAgentOptions = {},
): Promise<UtilityResult<InvokeAgentOutput>> {
  const adapter = options.adapter
  const layer = resolveLayer(
    options.layer,
    adapter
      ? {
          invokeAgent: invokeInput => adapter.invoke(invokeInput),
        }
      : {},
  )

  return runOrchestrationEffect(
    invokeAgentEffect(input, {timeoutMs: options.timeoutMs}),
    layer,
  )
}

export async function agentSandbox(
  input: AgentSandboxInput,
  options: AgentSandboxOptions = {},
): Promise<UtilityResult<AgentSandboxOutput>> {
  const adapter = options.adapter
  const layer = resolveLayer(
    options.layer,
    adapter
      ? {
          agentSandbox: sandboxInput => adapter.run(sandboxInput),
        }
      : {},
  )

  return runOrchestrationEffect(
    agentSandboxEffect(input, {timeoutMs: options.timeoutMs}),
    layer,
  )
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

export function createOrchestrationUtilitiesFromLayer(
  layer: OrchestrationLayer = defaultOrchestrationLayer,
): OrchestrationUtilities {
  return {
    askForRepo: (input, options = {}) =>
      runOrchestrationEffect(
        askForRepoEffect(input, {timeoutMs: options.timeoutMs}),
        layer,
      ),
    invokeAgent: (input, options = {}) =>
      runOrchestrationEffect(
        invokeAgentEffect(input, {timeoutMs: options.timeoutMs}),
        layer,
      ),
    agentSandbox: (input, options = {}) =>
      runOrchestrationEffect(
        agentSandboxEffect(input, {timeoutMs: options.timeoutMs}),
        layer,
      ),
  }
}

export function createOrchestrationUtilities(
  adapters: Partial<OrchestrationAdapters> = {},
): OrchestrationUtilities {
  return createOrchestrationUtilitiesFromLayer(createOrchestrationLayer(adapters))
}
