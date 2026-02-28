import type {PageOutput} from './helpers'

type JsonRecord = Record<string, unknown>
const ASK_FEEDBACK_CONTEXT_KEY = 'human_feedback'
const DEFAULT_LOOP_MAX_ITERATIONS = 100

export type EndStatus = 'done' | 'blocked' | 'failed'

export type StepKind = 'step' | 'ask' | 'decide' | 'loop' | 'write' | 'end'

export type StepLifecycle<C> = {
  name: string
  kind: StepKind
  ctx: C
}

export type StepLifecycleObserver<C, R = unknown, E = unknown> = (
  event: StepLifecycle<C>,
) => PipeResult<void, E, R>

export type AwaitFeedback<C> = {
  type: 'await_feedback'
  prompt: string
  ctx: C
}

export type EndSignal<C> = {
  type: 'end'
  status: EndStatus
  ctx: C
  message?: string
}

export type Control<C> = AwaitFeedback<C> | EndSignal<C>

export type WritePage<R = unknown, E = unknown> = (
  output: PageOutput,
) => PipeResult<void, E, R>

export type PipeInput<C, R = unknown, E = unknown> = {
  ctx: C
  feedback?: string
  task?: {id: string; title?: string; prompt?: string; context?: string}
  writePage?: WritePage<R, E>
  onStepStart?: StepLifecycleObserver<C, R, E>
  runId: string
  tickId: string
}

type PipeResult<T, _E = unknown, _R = unknown> = T | Promise<T>

export type Step<C, R = unknown, E = unknown> = (
  input: PipeInput<C, R, E>,
) => PipeResult<C | Control<C>, E, R>

export type PipeDefinition<C, R = unknown> = {
  id: string
  initial: C
  run: Step<C, R>
}

export type AskPrompt<C> = string | ((ctx: C) => string)

export type AskParse<C, R = never, E = unknown> = (
  ctx: C,
  reply: string,
) => PipeResult<C | Control<C>, E, R>

export type DecideOptions<C, R = unknown, E = unknown> = {
  otherwise?: Step<C, R, E>
}

export type LoopConfig<C, R = unknown, E = unknown> = {
  body: Step<C, R, E>
  until: (ctx: C) => PipeResult<boolean, E, R>
  max?: number
  onExhausted?: Step<C, R, E>
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null
}

function isControlSignal(value: unknown): value is Control<unknown> {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  return value.type === 'await_feedback' || value.type === 'end'
}

function normalizePageOutput(value: unknown): PageOutput {
  if (typeof value === 'string') return value
  if (isRecord(value) && typeof value.markdown === 'string') {
    const body = typeof value.body === 'string' ? value.body : undefined
    return body === undefined
      ? {markdown: value.markdown}
      : {markdown: value.markdown, body}
  }
  throw new Error(
    'write render must return a string or an object with markdown/body string fields',
  )
}

function readAskReply(input: {feedback?: string; ctx: unknown}): string | undefined {
  if (typeof input.feedback === 'string' && input.feedback.trim().length > 0) {
    return input.feedback.trim()
  }

  if (isRecord(input.ctx)) {
    const persistedReply = input.ctx[ASK_FEEDBACK_CONTEXT_KEY]
    if (
      typeof persistedReply === 'string' &&
      persistedReply.trim().length > 0
    ) {
      return persistedReply.trim()
    }
  }

  return undefined
}

function consumeAskFeedback<C>(ctx: C): C {
  if (!isRecord(ctx) || !(ASK_FEEDBACK_CONTEXT_KEY in ctx)) return ctx
  return {
    ...ctx,
    [ASK_FEEDBACK_CONTEXT_KEY]: undefined,
  } as C
}

function normalizeStepName(name: string, fallback: string): string {
  const trimmed = name.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

async function notifyStepStart<C, R = unknown, E = unknown>(
  input: PipeInput<C, R, E>,
  kind: StepKind,
  name: string,
  ctx?: C,
): Promise<void> {
  if (!input.onStepStart) return
  await input.onStepStart({
    kind,
    name: normalizeStepName(name, kind),
    ctx: ctx ?? input.ctx,
  })
}

export function definePipe<C, R = unknown>(
  definition: PipeDefinition<C, R>,
): PipeDefinition<C, R> {
  return definition
}

export function flow<C, R = unknown, E = unknown>(
  ...steps: readonly Step<C, R, E>[]
): Step<C, R, E> {
  return async (input: PipeInput<C>) => {
    let ctx = input.ctx

    for (const currentStep of steps) {
      const stepResult = await currentStep({...input, ctx})
      if (isControlSignal(stepResult)) return stepResult
      ctx = stepResult
    }

    return ctx
  }
}

export function step<C, R = unknown, E = unknown>(
  name: string,
  run: (ctx: C, input: PipeInput<C>) => PipeResult<C, E, R>,
): Step<C, R, E>
export function step<C, O, R = unknown, E = unknown>(
  name: string,
  run: (ctx: C, input: PipeInput<C>) => PipeResult<O, E, R>,
  assign: (ctx: C, out: O) => C,
): Step<C, R, E>
export function step<C, O, R = unknown, E = unknown>(
  name: string,
  run: (ctx: C, input: PipeInput<C>) => PipeResult<O, E, R>,
  assign?: (ctx: C, out: O) => C,
): Step<C, R, E> {
  const normalizedName = normalizeStepName(name, 'step')
  return async (input: PipeInput<C>) => {
    await notifyStepStart(input, 'step', normalizedName)
    const output = await run(input.ctx, input)
    return assign ? assign(input.ctx, output) : (output as C)
  }
}

export function ask<C, R = never, E = unknown>(
  prompt: AskPrompt<C>,
  parse: AskParse<C, R, E>,
): Step<C, R, E> {
  return async (input: PipeInput<C>) => {
    const ctx = consumeAskFeedback(input.ctx)
    const resolvedPrompt = typeof prompt === 'function' ? prompt(ctx) : prompt
    const askStepName =
      resolvedPrompt
        .split('\n')
        .map(line => line.trim())
        .find(line => line.length > 0) ?? 'ask'
    await notifyStepStart(input, 'ask', askStepName, ctx)
    const reply = readAskReply(input)

    if (!reply) {
      return {
        type: 'await_feedback',
        prompt: resolvedPrompt,
        ctx,
      } satisfies AwaitFeedback<C>
    }

    const parsed = await parse(ctx, reply)
    if (isControlSignal(parsed)) {
      return {
        ...parsed,
        ctx: consumeAskFeedback(parsed.ctx),
      }
    }

    return consumeAskFeedback(parsed)
  }
}

export function decide<C, K extends string, R = unknown, E = unknown>(
  select: (ctx: C) => PipeResult<K, E, R>,
  branches: Record<K, Step<C, R, E>>,
  options?: DecideOptions<C, R, E>,
): Step<C, R, E> {
  return async (input: PipeInput<C>) => {
    await notifyStepStart(input, 'decide', 'decide')
    const selected = await select(input.ctx)
    const branch =
      typeof selected === 'string' &&
      Object.prototype.hasOwnProperty.call(branches, selected)
        ? branches[selected]
        : undefined
    const resolvedBranch = branch ?? options?.otherwise
    if (!resolvedBranch) {
      return {
        type: 'end',
        status: 'failed',
        ctx: input.ctx,
        message: `Unknown branch selected: ${selected}`,
      } satisfies EndSignal<C>
    }
    return resolvedBranch(input)
  }
}

export function loop<C, R = unknown, E = unknown>(
  config: LoopConfig<C, R, E>,
): Step<C, R, E> {
  return async (input: PipeInput<C>) => {
    await notifyStepStart(input, 'loop', 'loop')
    const boundedMax =
      typeof config.max === 'number' && Number.isFinite(config.max)
        ? Math.max(0, Math.floor(config.max))
        : DEFAULT_LOOP_MAX_ITERATIONS

    let ctx = input.ctx
    let iteration = 0

    if (await config.until(ctx)) return ctx

    while (iteration < boundedMax) {

      const stepResult = await config.body({...input, ctx})
      if (isControlSignal(stepResult)) return stepResult

      ctx = stepResult
      iteration += 1

      if (await config.until(ctx)) return ctx
    }

    if (config.onExhausted) {
      return config.onExhausted({...input, ctx})
    }

    return {
      type: 'end',
      status: 'failed',
      ctx,
      message: 'Loop exhausted before completion',
    } satisfies EndSignal<C>
  }
}

export function write<C, R = unknown, E = unknown>(
  render: (ctx: C) => PipeResult<PageOutput, E, R>,
): Step<C, R, E> {
  return async (input: PipeInput<C>) => {
    await notifyStepStart(input, 'write', 'write')
    const pageOutput = normalizePageOutput(await render(input.ctx))
    if (input.writePage) {
      await input.writePage(pageOutput)
    }
    return input.ctx
  }
}

function endSignalStep<C>(status: EndStatus, message?: string): Step<C> {
  return async input => {
    await notifyStepStart(input, 'end', `end.${status}`)
    return {
      type: 'end',
      status,
      ctx: input.ctx,
      message,
    }
  }
}

export const end = {
  done: <C>(message?: string): Step<C> => endSignalStep('done', message),
  blocked: <C>(message?: string): Step<C> => endSignalStep('blocked', message),
  failed: <C>(message: string): Step<C> => endSignalStep('failed', message),
}
