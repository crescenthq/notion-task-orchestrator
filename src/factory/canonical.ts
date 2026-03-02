import type {PageOutput} from './helpers'
import {
  CheckpointMismatchError,
  checkpointFromPath,
  parseCheckpoint,
  prependCheckpointSegment,
  type Checkpoint,
  type CheckpointSegment,
} from './checkpoint'

export {CheckpointMismatchError}
export type {Checkpoint, CheckpointSegment} from './checkpoint'

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
  checkpoint?: Checkpoint
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
  checkpoint?: Checkpoint
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

function assertNoCheckpointRemainder(
  checkpoint: Checkpoint | undefined,
  location: string,
): void {
  if (!checkpoint || checkpoint.path.length === 0) return
  throw new CheckpointMismatchError(
    `Unexpected checkpoint segment ${checkpoint.path[0]?.k} at ${location}`,
  )
}

function consumeCheckpointSegment<K extends CheckpointSegment['k']>(
  inputCheckpoint: unknown,
  expectedKind: K,
  location: string,
): {
  segment?: Extract<CheckpointSegment, {k: K}>
  remainder?: Checkpoint
} {
  const checkpoint = parseCheckpoint(inputCheckpoint, {location})
  if (!checkpoint || checkpoint.path.length === 0) {
    return {}
  }

  const [segment, ...rest] = checkpoint.path
  if (segment.k !== expectedKind) {
    throw new CheckpointMismatchError(
      `Checkpoint kind mismatch at ${location}: expected ${expectedKind}, received ${segment.k}`,
    )
  }

  return {
    segment: segment as Extract<CheckpointSegment, {k: K}>,
    remainder: checkpointFromPath(rest),
  }
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
  if (isRecord(input.ctx) && ASK_FEEDBACK_CONTEXT_KEY in input.ctx) {
    const persistedReply = input.ctx[ASK_FEEDBACK_CONTEXT_KEY]
    if (
      typeof persistedReply === 'string' &&
      persistedReply.trim().length > 0
    ) {
      return persistedReply.trim()
    }

    return undefined
  }

  if (typeof input.feedback === 'string' && input.feedback.trim().length > 0) {
    return input.feedback.trim()
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
    const {segment, remainder} = consumeCheckpointSegment(
      input.checkpoint,
      'flow',
      'flow',
    )

    const startAt = segment?.at ?? 0
    if (segment && (startAt < 0 || startAt >= steps.length)) {
      throw new CheckpointMismatchError(
        `Flow checkpoint index ${startAt} is out of range`,
      )
    }

    let ctx = input.ctx

    for (let index = startAt; index < steps.length; index += 1) {
      const currentStep = steps[index]
      const stepCheckpoint = index === startAt ? remainder : undefined
      const stepResult = await currentStep({...input, ctx, checkpoint: stepCheckpoint})
      if (isControlSignal(stepResult)) {
        if (stepResult.type === 'await_feedback') {
          return {
            ...stepResult,
            checkpoint: prependCheckpointSegment(
              {k: 'flow', at: index},
              stepResult.checkpoint,
            ),
          }
        }
        return stepResult
      }
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
    const checkpoint = parseCheckpoint(input.checkpoint, {
      location: `step:${normalizedName}`,
    })
    assertNoCheckpointRemainder(checkpoint, `step:${normalizedName}`)
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
    const checkpoint = parseCheckpoint(input.checkpoint, {location: 'ask'})
    assertNoCheckpointRemainder(checkpoint, 'ask')

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
      if (parsed.type === 'await_feedback') {
        return {
          ...parsed,
          ctx: consumeAskFeedback(parsed.ctx),
          checkpoint: parseCheckpoint(parsed.checkpoint, {location: 'ask.parse'}),
        }
      }

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
    const {segment, remainder} = consumeCheckpointSegment(
      input.checkpoint,
      'decide',
      'decide',
    )

    await notifyStepStart(input, 'decide', 'decide')

    let selectedBranch: string | undefined
    let selectedLabel: string | undefined
    let resolvedBranch: Step<C, R, E> | undefined

    if (segment) {
      if (!Object.prototype.hasOwnProperty.call(branches, segment.branch)) {
        throw new CheckpointMismatchError(
          `Decide checkpoint branch not found: ${segment.branch}`,
        )
      }
      selectedBranch = segment.branch
      selectedLabel = segment.branch
      resolvedBranch = branches[segment.branch as K]
    } else {
      const selected = await select(input.ctx)
      selectedLabel = String(selected)
      const branch =
        typeof selected === 'string' &&
        Object.prototype.hasOwnProperty.call(branches, selected)
          ? branches[selected]
          : undefined

      selectedBranch = branch ? String(selected) : undefined
      resolvedBranch = branch ?? options?.otherwise
    }

    if (!resolvedBranch) {
      return {
        type: 'end',
        status: 'failed',
        ctx: input.ctx,
        message: `Unknown branch selected: ${selectedLabel}`,
      } satisfies EndSignal<C>
    }

    const branchResult = await resolvedBranch({
      ...input,
      checkpoint: segment ? remainder : undefined,
    })

    if (isControlSignal(branchResult) && branchResult.type === 'await_feedback') {
      if (!selectedBranch) {
        return branchResult
      }

      return {
        ...branchResult,
        checkpoint: prependCheckpointSegment(
          {k: 'decide', branch: selectedBranch},
          branchResult.checkpoint,
        ),
      }
    }

    return branchResult
  }
}

export function loop<C, R = unknown, E = unknown>(
  config: LoopConfig<C, R, E>,
): Step<C, R, E> {
  return async (input: PipeInput<C>) => {
    const {segment, remainder} = consumeCheckpointSegment(
      input.checkpoint,
      'loop',
      'loop',
    )

    await notifyStepStart(input, 'loop', 'loop')
    const boundedMax =
      typeof config.max === 'number' && Number.isFinite(config.max)
        ? Math.max(0, Math.floor(config.max))
        : DEFAULT_LOOP_MAX_ITERATIONS

    let ctx = input.ctx
    let iteration = segment?.iter ?? 0
    let bodyCheckpoint = segment ? remainder : undefined

    if (segment && (iteration < 0 || iteration >= boundedMax)) {
      throw new CheckpointMismatchError(
        `Loop checkpoint iteration ${iteration} is out of range`,
      )
    }

    if (!segment && (await config.until(ctx))) return ctx

    while (iteration < boundedMax) {
      const stepResult = await config.body({
        ...input,
        ctx,
        checkpoint: bodyCheckpoint,
      })
      if (isControlSignal(stepResult)) {
        if (stepResult.type === 'await_feedback') {
          return {
            ...stepResult,
            checkpoint: prependCheckpointSegment(
              {k: 'loop', iter: iteration},
              stepResult.checkpoint,
            ),
          }
        }
        return stepResult
      }

      ctx = stepResult
      iteration += 1
      bodyCheckpoint = undefined

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
    const checkpoint = parseCheckpoint(input.checkpoint, {location: 'write'})
    assertNoCheckpointRemainder(checkpoint, 'write')
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
    const checkpoint = parseCheckpoint(input.checkpoint, {
      location: `end.${status}`,
    })
    assertNoCheckpointRemainder(checkpoint, `end.${status}`)
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
