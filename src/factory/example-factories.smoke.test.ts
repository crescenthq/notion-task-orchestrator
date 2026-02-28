import {describe, expect, it} from 'vitest'
import expressivePrimitives from '../../example-factories/factories/expressive-primitives'
import intentFactory from '../../example-factories/factories/intent'
import magic8Factory from '../../example-factories/factories/magic-8'
import sharedHelperDemo from '../../example-factories/factories/shared-helper-demo'
import wouldYouRatherFactory from '../../example-factories/factories/would-you-rather'

type AwaitFeedbackSignal = {
  type: 'await_feedback'
  prompt: string
  ctx: Record<string, unknown>
}

type EndSignal = {
  type: 'end'
  status: 'done' | 'blocked' | 'failed'
  ctx: Record<string, unknown>
  message?: string
}

type PageOutput = string | {markdown: string; body?: string}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function expectAwaitFeedback(value: unknown): AwaitFeedbackSignal {
  if (
    !isRecord(value) ||
    value.type !== 'await_feedback' ||
    typeof value.prompt !== 'string' ||
    !isRecord(value.ctx)
  ) {
    throw new Error(`Expected await_feedback signal, got: ${JSON.stringify(value)}`)
  }

  return value as AwaitFeedbackSignal
}

function expectEnd(value: unknown): EndSignal {
  if (
    !isRecord(value) ||
    value.type !== 'end' ||
    (value.status !== 'done' &&
      value.status !== 'blocked' &&
      value.status !== 'failed') ||
    !isRecord(value.ctx)
  ) {
    throw new Error(`Expected end signal, got: ${JSON.stringify(value)}`)
  }

  return value as EndSignal
}

describe('example factories smoke', () => {
  it('runs expressive-primitives through the approve path', async () => {
    const writes: PageOutput[] = []

    const result = await expressivePrimitives.run({
      ctx: expressivePrimitives.initial,
      feedback: 'approve',
      runId: 'run-expressive',
      tickId: 'tick-expressive',
      writePage: async output => {
        writes.push(output)
      },
    })

    const end = expectEnd(result)
    expect(end.status).toBe('done')
    expect(end.ctx.decision).toBe('approve')
    expect(writes).toHaveLength(1)
    expect(typeof writes[0] === 'string' ? writes[0] : writes[0]?.markdown).toContain(
      'Expressive Primitive Demo',
    )
  })

  it('runs shared-helper-demo to completion', async () => {
    const writes: PageOutput[] = []

    const result = await sharedHelperDemo.run({
      ctx: sharedHelperDemo.initial,
      runId: 'run-shared',
      tickId: 'tick-shared',
      writePage: async output => {
        writes.push(output)
      },
    })

    const end = expectEnd(result)
    expect(end.status).toBe('done')
    expect(end.ctx.finished).toBe(true)
    expect(end.ctx.attempts).toBe(2)
    expect(writes).toHaveLength(1)
  })

  it('supports pause/resume in magic-8 flow', async () => {
    const first = await magic8Factory.run({
      ctx: magic8Factory.initial,
      runId: 'run-magic-1',
      tickId: 'tick-magic-1',
    })
    const firstAwait = expectAwaitFeedback(first)
    expect(firstAwait.prompt).toContain('Ask a yes/no question')

    const second = await magic8Factory.run({
      ctx: firstAwait.ctx as typeof magic8Factory.initial,
      feedback: 'Will this release go smoothly?',
      runId: 'run-magic-2',
      tickId: 'tick-magic-2',
    })
    const secondAwait = expectAwaitFeedback(second)
    expect(secondAwait.prompt).toContain('Ask another? (yes/no)')

    const writes: PageOutput[] = []
    const third = await magic8Factory.run({
      ctx: secondAwait.ctx as typeof magic8Factory.initial,
      feedback: 'no',
      runId: 'run-magic-3',
      tickId: 'tick-magic-3',
      writePage: async output => {
        writes.push(output)
      },
    })
    const finalEnd = expectEnd(third)
    expect(finalEnd.status).toBe('done')
    expect(Array.isArray(finalEnd.ctx.history)).toBe(true)
    expect((finalEnd.ctx.history as unknown[]).length).toBe(1)
    expect(writes).toHaveLength(1)
  })

  it('handles invalid then valid input in would-you-rather', async () => {
    const first = await wouldYouRatherFactory.run({
      ctx: wouldYouRatherFactory.initial,
      runId: 'run-rather-1',
      tickId: 'tick-rather-1',
    })
    const firstAwait = expectAwaitFeedback(first)
    expect(firstAwait.prompt).toContain('Reply with A or B')

    const second = await wouldYouRatherFactory.run({
      ctx: firstAwait.ctx as typeof wouldYouRatherFactory.initial,
      feedback: 'maybe',
      runId: 'run-rather-2',
      tickId: 'tick-rather-2',
    })
    const secondAwait = expectAwaitFeedback(second)
    expect(secondAwait.prompt).toContain('Please reply with only A or B')

    const writes: PageOutput[] = []
    const third = await wouldYouRatherFactory.run({
      ctx: secondAwait.ctx as typeof wouldYouRatherFactory.initial,
      feedback: 'A',
      runId: 'run-rather-3',
      tickId: 'tick-rather-3',
      writePage: async output => {
        writes.push(output)
      },
    })
    const end = expectEnd(third)
    expect(end.status).toBe('done')
    expect(end.ctx.choice).toBe('A')
    expect(end.ctx.selected_option).toBeTruthy()
    expect(writes).toHaveLength(1)
  })

  it('captures an intent brief and completes in one reviewed pass', async () => {
    const first = await intentFactory.run({
      ctx: intentFactory.initial,
      runId: 'run-intent-1',
      tickId: 'tick-intent-1',
    })
    const awaitIntent = expectAwaitFeedback(first)
    expect(awaitIntent.prompt).toContain('Describe the request in one message')

    const writes: PageOutput[] = []
    const second = await intentFactory.run({
      ctx: awaitIntent.ctx as typeof intentFactory.initial,
      feedback:
        'repo=https://github.com/notionflow/example.git; feature=Add a clear progress dashboard for task runs.; decision=approve',
      runId: 'run-intent-2',
      tickId: 'tick-intent-2',
      writePage: async output => {
        writes.push(output)
      },
    })

    const end = expectEnd(second)
    expect(end.status).toBe('done')
    expect(end.ctx.review_decision).toBe('approve')
    expect(writes).toHaveLength(1)
  })
})
