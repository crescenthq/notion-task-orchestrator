import {z} from 'zod'

const nonEmptyString = z.string().trim().min(1)
const isoTimestamp = nonEmptyString.refine(
  value => !Number.isNaN(Date.parse(value)),
  {message: 'must be an ISO timestamp'},
)

const jsonString = z.string().refine(value => {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}, 'must be a JSON string')

export const runTraceTypes = [
  'started',
  'resumed',
  'step',
  'retry',
  'await_feedback',
  'write',
  'completed',
  'error',
] as const

export const runTraceTypeSchema = z.enum(runTraceTypes)
export type RunTraceType = z.infer<typeof runTraceTypeSchema>

export const runTraceStatuses = [
  'running',
  'feedback',
  'done',
  'blocked',
  'failed',
] as const
export const runTraceStatusSchema = z.enum(runTraceStatuses)
export type RunTraceStatus = z.infer<typeof runTraceStatusSchema>

export const runTraceReasonCodes = [
  'action.done',
  'action.feedback',
  'action.failed.exhausted',
  'action.attempt.failed',
  'action.attempt.error',
  'orchestrate.agent',
  'orchestrate.select',
  'loop.continue',
  'loop.done',
  'loop.exhausted',
] as const

export const runTraceReasonSchema = z.enum(runTraceReasonCodes)
export type RunTraceReasonCode = z.infer<typeof runTraceReasonSchema>

export const runTraceSchema = z
  .object({
    id: nonEmptyString,
    runId: nonEmptyString,
    tickId: nonEmptyString,
    taskId: nonEmptyString,
    type: runTraceTypeSchema,
    stateId: nonEmptyString.nullable().optional(),
    fromStateId: nonEmptyString.nullable().optional(),
    toStateId: nonEmptyString.nullable().optional(),
    event: nonEmptyString.nullable().optional(),
    reason: runTraceReasonSchema.nullable().optional(),
    attempt: z.number().int().min(0).default(0),
    loopIteration: z.number().int().min(0).default(0),
    status: runTraceStatusSchema.nullable().optional(),
    message: nonEmptyString.nullable().optional(),
    payloadJson: jsonString.nullable().optional(),
    timestamp: isoTimestamp,
  })
  .superRefine((value, ctx) => {
    const hasString = (candidate: unknown): candidate is string =>
      typeof candidate === 'string' && candidate.trim().length > 0

    const requireStringField = (
      field:
        | 'stateId'
        | 'fromStateId'
        | 'toStateId'
        | 'event'
        | 'reason'
        | 'message'
        | 'status',
      message: string,
    ) => {
      if (!hasString(value[field])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message,
        })
      }
    }

    switch (value.type) {
      case 'started':
      case 'resumed':
        requireStringField('stateId', `${value.type} traces require stateId`)
        break
      case 'step':
        requireStringField('fromStateId', 'step traces require fromStateId')
        requireStringField('toStateId', 'step traces require toStateId')
        requireStringField('event', 'step traces require event')
        requireStringField('reason', 'step traces require reason')
        break
      case 'retry':
        requireStringField('stateId', 'retry traces require stateId')
        requireStringField('reason', 'retry traces require reason')
        if (value.attempt < 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['attempt'],
            message: 'retry traces require attempt >= 1',
          })
        }
        break
      case 'await_feedback':
        requireStringField(
          'stateId',
          'await_feedback traces require stateId',
        )
        break
      case 'write':
        requireStringField('stateId', 'write traces require stateId')
        break
      case 'completed':
        requireStringField('status', 'completed traces require terminal status')
        if (
          value.status === 'running' ||
          value.status === 'feedback' ||
          value.status === null
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['status'],
            message: 'completed traces require done, blocked, or failed status',
          })
        }
        break
      case 'error':
        requireStringField('message', 'error traces require message')
        if (value.status && value.status !== 'failed') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['status'],
            message: 'error traces may only use failed status when provided',
          })
        }
        break
      default:
        break
    }
  })

export type RunTraceRecord = z.infer<typeof runTraceSchema>

export const transitionLikeRunTraceTypes = ['step', 'retry'] as const
export type TransitionLikeRunTraceType =
  (typeof transitionLikeRunTraceTypes)[number]

export function isTransitionLikeRunTrace(
  trace: Pick<RunTraceRecord, 'type'>,
): trace is RunTraceRecord & {type: TransitionLikeRunTraceType} {
  return trace.type === 'step' || trace.type === 'retry'
}

export function parseRunTrace(input: unknown): RunTraceRecord {
  return runTraceSchema.parse(input)
}

export function replayRunTraces(traces: ReadonlyArray<unknown>): string | null {
  if (traces.length === 0) return null

  const parsed = traces.map(trace => parseRunTrace(trace))
  let currentStateId: string | null = null
  let waitingForFeedback = false

  for (const trace of parsed) {
    if (trace.type === 'started' || trace.type === 'resumed') {
      if (trace.stateId) currentStateId = trace.stateId
      waitingForFeedback = false
      continue
    }

    if (trace.type === 'await_feedback') {
      if (trace.stateId) currentStateId = trace.stateId
      waitingForFeedback = true
      continue
    }

    if (trace.type === 'completed') {
      return trace.status ?? currentStateId
    }

    if (trace.type === 'error') {
      return 'failed'
    }

    const fromStateId = trace.fromStateId ?? trace.stateId ?? currentStateId
    const toStateId = trace.toStateId ?? trace.stateId ?? currentStateId
    if (fromStateId && currentStateId && fromStateId !== currentStateId) {
      if (!waitingForFeedback) {
        throw new Error(
          `Replay mismatch for trace ${trace.id}: expected fromState=${currentStateId}, got ${fromStateId}`,
        )
      }
      currentStateId = fromStateId
    }

    if (toStateId) currentStateId = toStateId
    waitingForFeedback = trace.reason === 'action.feedback'
  }

  if (waitingForFeedback) return 'feedback'
  return currentStateId
}
