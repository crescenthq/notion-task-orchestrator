import {factorySchema, type FactoryDefinition} from '../core/factorySchema'
import type {
  ActionResult,
  ActionStatus,
  PageOutput,
  Selector,
  Until,
} from './helpers'

type PrimitiveConfig = Record<string, unknown>
type PrimitiveContext = Record<string, unknown>
export type PrimitiveName =
  | 'step'
  | 'ask'
  | 'route'
  | 'loop'
  | 'retry'
  | 'publish'
  | 'end'
export type PrimitiveRoutedStatus = ActionStatus
export type TerminalStatus = 'done' | 'blocked' | 'failed'

export type PrimitiveRuntimeInput<
  TContext extends PrimitiveContext = PrimitiveContext,
> = {
  ctx: TContext
  task?: Record<string, unknown>
  feedback?: string
}

export type PrimitiveTransitionMap<TEvent extends string = string> = Record<
  TEvent,
  string
>

export type ActionTransitionMap = PrimitiveTransitionMap<'done' | 'failed'> &
  Partial<PrimitiveTransitionMap<'feedback'>>

type CompiledActionState = Extract<
  FactoryDefinition['states'][string],
  {type: 'action'}
>
type CompiledOrchestrateState = Extract<
  FactoryDefinition['states'][string],
  {type: 'orchestrate'}
>
type CompiledLoopState = Extract<FactoryDefinition['states'][string], {type: 'loop'}>
type CompiledTerminalState = Extract<
  FactoryDefinition['states'][string],
  {type: TerminalStatus}
>
type CompiledFactoryState = FactoryDefinition['states'][string]
type CompiledStateRecord = Record<string, CompiledFactoryState>

const ASK_FEEDBACK_CONTEXT_KEY = 'human_feedback'
const ASK_FEEDBACK_STATE_SUFFIX = '__feedback'
const ROUTE_UNMAPPED_EVENT = '__route_unmapped__'
const ROUTE_FALLBACK_STATE_SUFFIX = '__route_failed'

export type CompiledFactoryDefinition = FactoryDefinition
export type CompiledFactoryStates = FactoryDefinition['states']
export type CompiledFactoryGuards = NonNullable<FactoryDefinition['guards']>
export type CompiledRetryConfig = NonNullable<CompiledActionState['retries']>
export type CompiledRetryBackoff = NonNullable<CompiledRetryConfig['backoff']>

export type CompilerTargetFactory = Pick<
  FactoryDefinition,
  'id' | 'start' | 'context' | 'states' | 'guards'
>

export type CompileFactoryResult = {
  factory: CompiledFactoryDefinition
  start: FactoryDefinition['start']
  states: CompiledFactoryStates
  guards?: CompiledFactoryGuards
}

export type RetryPrimitiveConfig = {
  max: CompiledRetryConfig['max']
  backoff?: CompiledRetryBackoff
} & PrimitiveConfig

type RetryPrimitiveReference =
  | RetryPrimitiveConfig
  | PrimitiveNode<'retry', RetryPrimitiveConfig>

export type StepHandler<
  TContext extends PrimitiveContext = PrimitiveContext,
  TData extends PrimitiveContext = PrimitiveContext,
> = (
  input: PrimitiveRuntimeInput<TContext>,
) => ActionResult<TData> | Promise<ActionResult<TData>>

export type StepPrimitiveConfig<
  TContext extends PrimitiveContext = PrimitiveContext,
  TData extends PrimitiveContext = PrimitiveContext,
> = {
  run: StepHandler<TContext, TData>
  on: ActionTransitionMap
  retries?: RetryPrimitiveReference
} & PrimitiveConfig

export type AskPrompt<
  TContext extends PrimitiveContext = PrimitiveContext,
> = string | ((input: PrimitiveRuntimeInput<TContext>) => string | Promise<string>)

export type AskParser<
  TContext extends PrimitiveContext = PrimitiveContext,
  TData extends PrimitiveContext = PrimitiveContext,
> = (
  reply: string,
  input: PrimitiveRuntimeInput<TContext>,
) => ActionResult<TData> | Promise<ActionResult<TData>>

export type AskPrimitiveConfig<
  TContext extends PrimitiveContext = PrimitiveContext,
  TData extends PrimitiveContext = PrimitiveContext,
> = {
  prompt: AskPrompt<TContext>
  on: ActionTransitionMap
  parse?: AskParser<TContext, TData>
  resume?: 'previous' | string
} & PrimitiveConfig

export type RoutePrimitiveConfig<
  TContext extends PrimitiveContext = PrimitiveContext,
  TEvent extends string = string,
> = {
  select: Selector<PrimitiveRuntimeInput<TContext>, TEvent>
  on: PrimitiveTransitionMap<TEvent>
} & PrimitiveConfig

export type LoopRuntimeInput<
  TContext extends PrimitiveContext = PrimitiveContext,
> = {
  ctx: TContext
  iteration: number
}

export type LoopTransitionEvent = 'continue' | 'done' | 'exhausted'
export type LoopTransitionMap = PrimitiveTransitionMap<LoopTransitionEvent>

export type LoopPrimitiveConfig<
  TContext extends PrimitiveContext = PrimitiveContext,
> = {
  body: string
  maxIterations: CompiledLoopState['maxIterations']
  until?: string | Until<LoopRuntimeInput<TContext>>
  on: LoopTransitionMap
} & PrimitiveConfig

export type PublishRenderer<
  TContext extends PrimitiveContext = PrimitiveContext,
> = (
  input: PrimitiveRuntimeInput<TContext>,
) => PageOutput | Promise<PageOutput>

export type PublishPrimitiveConfig<
  TContext extends PrimitiveContext = PrimitiveContext,
> = {
  render: PublishRenderer<TContext>
  on?: PrimitiveTransitionMap<'done' | 'failed'>
} & PrimitiveConfig

export type EndPrimitiveConfig<
  TStatus extends TerminalStatus = TerminalStatus,
> = {
  status: TStatus
} & PrimitiveConfig

export type PrimitiveNode<
  TPrimitive extends PrimitiveName,
  TConfig extends PrimitiveConfig,
> = {
  primitive: TPrimitive
  config: TConfig
}

export type ExpressiveFactoryStateNode =
  | PrimitiveNode<'step', StepPrimitiveConfig<any, any>>
  | PrimitiveNode<'ask', AskPrimitiveConfig<any, any>>
  | PrimitiveNode<'route', RoutePrimitiveConfig<any, any>>
  | PrimitiveNode<'loop', LoopPrimitiveConfig<any>>
  | PrimitiveNode<'retry', RetryPrimitiveConfig>
  | PrimitiveNode<'publish', PublishPrimitiveConfig<any>>
  | PrimitiveNode<'end', EndPrimitiveConfig>

export type ExpressiveFactoryState =
  | ExpressiveFactoryStateNode
  | FactoryDefinition['states'][string]

export type ExpressiveFactoryDefinition<
  TContext extends PrimitiveContext = PrimitiveContext,
> = {
  id: CompilerTargetFactory['id']
  start: CompilerTargetFactory['start']
  context?: TContext
  states: Record<string, ExpressiveFactoryState>
  guards?: CompiledFactoryGuards
}

function compileStepPrimitive(
  config: StepPrimitiveConfig<any, any>,
): CompiledActionState {
  return {
    type: 'action',
    agent: config.run,
    on: {...config.on},
    retries: config.retries
      ? compileRetryPrimitive(config.retries)
      : undefined,
  }
}

function isRetryPrimitiveNode(
  retryConfig: RetryPrimitiveReference,
): retryConfig is PrimitiveNode<'retry', RetryPrimitiveConfig> {
  return (
    typeof retryConfig === 'object' &&
    retryConfig !== null &&
    'primitive' in retryConfig &&
    retryConfig.primitive === 'retry' &&
    'config' in retryConfig
  )
}

function compileRetryPrimitive(
  retryConfig: RetryPrimitiveReference,
): CompiledRetryConfig {
  const resolvedConfig = isRetryPrimitiveNode(retryConfig)
    ? retryConfig.config
    : retryConfig

  return {
    max: resolvedConfig.max,
    backoff: resolvedConfig.backoff,
  }
}

function getAskFeedbackStateId(stateId: string): string {
  return `${stateId}${ASK_FEEDBACK_STATE_SUFFIX}`
}

function getRouteFallbackStateId(stateId: string): string {
  return `${stateId}${ROUTE_FALLBACK_STATE_SUFFIX}`
}

async function resolveAskPrompt(
  prompt: AskPrompt<any>,
  input: PrimitiveRuntimeInput<any>,
): Promise<string> {
  if (typeof prompt === 'function') {
    return prompt(input)
  }
  return prompt
}

function readAskReply(input: PrimitiveRuntimeInput<any>): string | undefined {
  if (typeof input.feedback === 'string' && input.feedback.trim().length > 0) {
    return input.feedback
  }

  const contextReply = input.ctx[ASK_FEEDBACK_CONTEXT_KEY]
  if (typeof contextReply === 'string' && contextReply.trim().length > 0) {
    return contextReply
  }

  return undefined
}

function withConsumedAskFeedback(data?: PrimitiveContext): PrimitiveContext {
  const merged: PrimitiveContext = data ? {...data} : {}
  merged[ASK_FEEDBACK_CONTEXT_KEY] = undefined
  return {
    ...merged,
  }
}

function compileAskPrimitive(
  stateId: string,
  config: AskPrimitiveConfig<any, any>,
): CompiledStateRecord {
  const feedbackStateId = getAskFeedbackStateId(stateId)
  const resumeTarget = config.resume ?? config.on.feedback ?? 'previous'

  const askAgent: StepHandler<any, any> = async input => {
    const reply = readAskReply(input)
    if (!reply) {
      return {
        status: 'feedback',
        message: await resolveAskPrompt(config.prompt, input),
        data: withConsumedAskFeedback(),
      }
    }

    const parsedResult: ActionResult<PrimitiveContext> = config.parse
      ? await config.parse(reply, input)
      : {status: 'done'}

    const feedbackPrompt =
      parsedResult.status === 'feedback' && parsedResult.message === undefined
        ? await resolveAskPrompt(config.prompt, input)
        : undefined

    return {
      ...parsedResult,
      message: feedbackPrompt ?? parsedResult.message,
      data: withConsumedAskFeedback(parsedResult.data),
    }
  }

  return {
    [stateId]: {
      type: 'action',
      agent: askAgent,
      on: {
        done: config.on.done,
        feedback: feedbackStateId,
        failed: config.on.failed,
      },
    },
    [feedbackStateId]: {
      type: 'feedback',
      resume: resumeTarget,
    },
  }
}

function compileRoutePrimitive(
  stateId: string,
  config: RoutePrimitiveConfig<any, any>,
): CompiledStateRecord {
  const fallbackStateId = getRouteFallbackStateId(stateId)
  const on: Record<string, string> = {...config.on}
  const hasCustomFallback = Boolean(on[ROUTE_UNMAPPED_EVENT])

  if (!hasCustomFallback) {
    on[ROUTE_UNMAPPED_EVENT] = fallbackStateId
  }

  const select: CompiledOrchestrateState['select'] = async input => {
    const selectedEvent = await config.select(input as PrimitiveRuntimeInput<any>)
    const normalizedEvent =
      typeof selectedEvent === 'string' && selectedEvent.trim().length > 0
        ? selectedEvent
        : ROUTE_UNMAPPED_EVENT
    return on[normalizedEvent] ? normalizedEvent : ROUTE_UNMAPPED_EVENT
  }

  const compiledStates: CompiledStateRecord = {
    [stateId]: {
      type: 'orchestrate',
      select,
      on,
    },
  }

  if (!hasCustomFallback) {
    compiledStates[fallbackStateId] = {type: 'failed'}
  }

  return compiledStates
}

function compileLoopPrimitive(
  config: LoopPrimitiveConfig<any>,
): CompiledLoopState {
  return {
    type: 'loop',
    body: config.body,
    maxIterations: config.maxIterations,
    until: config.until,
    on: {
      ...config.on,
      continue: config.body,
    },
  }
}

function compilePublishPrimitive(
  config: PublishPrimitiveConfig<any>,
): CompiledActionState {
  const publishAgent: StepHandler<any, any> = async input => ({
    status: 'done',
    page: await config.render(input),
  })

  return {
    type: 'action',
    agent: publishAgent,
    on: {
      done: config.on?.done ?? 'done',
      failed: config.on?.failed ?? 'failed',
    },
  }
}

function compileEndPrimitive(config: EndPrimitiveConfig): CompiledTerminalState {
  return {type: config.status}
}

function compilePrimitiveState(
  stateId: string,
  node: ExpressiveFactoryState,
): CompiledStateRecord {
  if ('type' in node) return {[stateId]: node}

  switch (node.primitive) {
    case 'step':
      return {[stateId]: compileStepPrimitive(node.config)}
    case 'ask':
      return compileAskPrimitive(stateId, node.config)
    case 'route':
      return compileRoutePrimitive(stateId, node.config)
    case 'loop':
      return {[stateId]: compileLoopPrimitive(node.config)}
    case 'publish':
      return {[stateId]: compilePublishPrimitive(node.config)}
    case 'end':
      return {[stateId]: compileEndPrimitive(node.config)}
    default:
      throw new Error(
        `Primitive \`${node.primitive}\` for state \`${stateId}\` is not implemented yet`,
      )
  }
}

function appendCompiledStates(
  targetStates: CompiledFactoryStates,
  compiledStates: CompiledStateRecord,
  sourceStateId: string,
): void {
  for (const [compiledStateId, compiledState] of Object.entries(compiledStates)) {
    if (targetStates[compiledStateId]) {
      throw new Error(
        `State id collision while compiling \`${sourceStateId}\`: \`${compiledStateId}\` already exists`,
      )
    }
    targetStates[compiledStateId] = compiledState
  }
}

export function compileExpressiveFactory(
  definition: ExpressiveFactoryDefinition,
): CompileFactoryResult {
  const states: CompiledFactoryStates = {}
  for (const [stateId, node] of Object.entries(definition.states)) {
    appendCompiledStates(states, compilePrimitiveState(stateId, node), stateId)
  }

  const factory = factorySchema.parse({
    id: definition.id,
    start: definition.start,
    context: definition.context,
    states,
    guards: definition.guards,
  })

  return {
    factory,
    start: factory.start,
    states: factory.states,
    guards: factory.guards,
  }
}

function definePrimitive<
  TPrimitive extends PrimitiveName,
  TConfig extends PrimitiveConfig,
>(primitive: TPrimitive, config: TConfig): PrimitiveNode<TPrimitive, TConfig> {
  return {primitive, config}
}

export function step<TConfig extends StepPrimitiveConfig<any, any>>(
  config: TConfig,
): PrimitiveNode<'step', TConfig> {
  return definePrimitive('step', config)
}

export function ask<TConfig extends AskPrimitiveConfig<any, any>>(
  config: TConfig,
): PrimitiveNode<'ask', TConfig> {
  return definePrimitive('ask', config)
}

export function route<TConfig extends RoutePrimitiveConfig<any, any>>(
  config: TConfig,
): PrimitiveNode<'route', TConfig> {
  return definePrimitive('route', config)
}

export function loop<TConfig extends LoopPrimitiveConfig<any>>(
  config: TConfig,
): PrimitiveNode<'loop', TConfig> {
  return definePrimitive('loop', config)
}

export function retry<TConfig extends RetryPrimitiveConfig>(
  config: TConfig,
): PrimitiveNode<'retry', TConfig> {
  return definePrimitive('retry', config)
}

export function publish<TConfig extends PublishPrimitiveConfig<any>>(
  config: TConfig,
): PrimitiveNode<'publish', TConfig> {
  return definePrimitive('publish', config)
}

export function end<TConfig extends EndPrimitiveConfig>(
  config: TConfig,
): PrimitiveNode<'end', TConfig> {
  return definePrimitive('end', config)
}
