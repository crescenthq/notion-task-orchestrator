import {z} from 'zod'

export const transitionEventReasonCodes = [
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

export const transitionEventReasonSchema = z.enum(transitionEventReasonCodes)
export type TransitionEventReasonCode = z.infer<
  typeof transitionEventReasonSchema
>

const nonEmptyString = z.string().trim().min(1)
const isoTimestamp = nonEmptyString.refine(
  value => !Number.isNaN(Date.parse(value)),
  {
    message: 'must be an ISO timestamp',
  },
)

export const transitionEventSchema = z
  .object({
    id: nonEmptyString,
    runId: nonEmptyString,
    tickId: nonEmptyString,
    taskId: nonEmptyString,
    fromStateId: nonEmptyString,
    toStateId: nonEmptyString,
    event: nonEmptyString,
    reason: transitionEventReasonSchema,
    attempt: z.number().int().min(0),
    loopIteration: z.number().int().min(0),
    timestamp: isoTimestamp,
  })
  .superRefine((value, ctx) => {
    const assertEvent = (expected: string) => {
      if (value.event !== expected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['event'],
          message: `reason \`${value.reason}\` requires event \`${expected}\``,
        })
      }
    }

    switch (value.reason) {
      case 'action.done':
        assertEvent('done')
        break
      case 'action.feedback':
        assertEvent('feedback')
        break
      case 'action.failed.exhausted':
        assertEvent('failed')
        break
      case 'action.attempt.failed':
      case 'action.attempt.error':
        assertEvent('failed')
        if (value.fromStateId !== value.toStateId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['toStateId'],
            message:
              'action attempt events must keep fromStateId and toStateId equal',
          })
        }
        break
      case 'loop.continue':
        assertEvent('continue')
        break
      case 'loop.done':
        assertEvent('done')
        break
      case 'loop.exhausted':
        assertEvent('exhausted')
        break
      case 'orchestrate.agent':
      case 'orchestrate.select':
        break
      default:
        break
    }
  })

export type TransitionEventRecord = z.infer<typeof transitionEventSchema>

export function parseTransitionEvent(input: unknown): TransitionEventRecord {
  return transitionEventSchema.parse(input)
}

export function replayTransitionEvents(
  events: ReadonlyArray<unknown>,
): string | null {
  if (events.length === 0) return null
  const parsed = events.map(event => parseTransitionEvent(event))
  let current = parsed[0].fromStateId
  let previousEvent: TransitionEventRecord | null = null

  for (const event of parsed) {
    if (event.fromStateId !== current) {
      const resumedFromFeedback = previousEvent?.reason === 'action.feedback'
      if (!resumedFromFeedback) {
        throw new Error(
          `Replay mismatch for event ${event.id}: expected fromState=${current}, got ${event.fromStateId}`,
        )
      }
      current = event.fromStateId
    }

    current = event.toStateId
    previousEvent = event
  }

  return current
}
