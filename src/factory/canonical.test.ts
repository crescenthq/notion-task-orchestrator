import {describe, expect, it, vi} from 'vitest'
import {ask, decide, end, flow, loop, step, write, type PipeInput} from './canonical'

type TestCtx = {
  score: number
  trail: string[]
}

const baseInput: PipeInput<TestCtx> = {
  ctx: {score: 0, trail: []},
  runId: 'run-1',
  tickId: 'tick-1',
  task: {
    id: 'task-1',
    title: 'Canonical flow test task',
  },
}

describe('canonical flow helper', () => {
  it('sequences steps and threads latest context between each step', async () => {
    const first = vi.fn(async (input: PipeInput<TestCtx>) => ({
      ...input.ctx,
      score: input.ctx.score + 1,
      trail: [...input.ctx.trail, 'first'],
    }))
    const second = vi.fn(async (input: PipeInput<TestCtx>) => ({
      ...input.ctx,
      score: input.ctx.score + 2,
      trail: [...input.ctx.trail, 'second'],
    }))
    const third = vi.fn(async (input: PipeInput<TestCtx>) => ({
      ...input.ctx,
      score: input.ctx.score + 3,
      trail: [...input.ctx.trail, 'third'],
    }))

    const run = flow(first, second, third)
    const result = await run(baseInput)

    expect(result).toEqual({
      score: 6,
      trail: ['first', 'second', 'third'],
    })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(third).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: {score: 1, trail: ['first']},
      }),
    )
    expect(third).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: {score: 3, trail: ['first', 'second']},
      }),
    )
  })

  it('short-circuits remaining steps when a step returns await_feedback', async () => {
    const first = vi.fn(async (input: PipeInput<TestCtx>) => ({
      ...input.ctx,
      score: input.ctx.score + 1,
      trail: [...input.ctx.trail, 'first'],
    }))
    const awaitFeedback = vi.fn(async (input: PipeInput<TestCtx>) => ({
      type: 'await_feedback' as const,
      prompt: 'Please reply',
      ctx: input.ctx,
    }))
    const skipped = vi.fn(async (input: PipeInput<TestCtx>) => ({
      ...input.ctx,
      score: input.ctx.score + 1,
      trail: [...input.ctx.trail, 'skipped'],
    }))

    const run = flow(first, awaitFeedback, skipped)
    const result = await run(baseInput)

    expect(result).toEqual({
      type: 'await_feedback',
      prompt: 'Please reply',
      ctx: {score: 1, trail: ['first']},
    })
    expect(first).toHaveBeenCalledTimes(1)
    expect(awaitFeedback).toHaveBeenCalledTimes(1)
    expect(skipped).not.toHaveBeenCalled()
  })

  it('short-circuits remaining steps when a step returns end signal', async () => {
    const first = vi.fn(async (input: PipeInput<TestCtx>) => ({
      ...input.ctx,
      score: input.ctx.score + 2,
      trail: [...input.ctx.trail, 'first'],
    }))
    const endNow = vi.fn(async (input: PipeInput<TestCtx>) => ({
      type: 'end' as const,
      status: 'blocked' as const,
      message: 'Need manual review',
      ctx: input.ctx,
    }))
    const skipped = vi.fn(async (input: PipeInput<TestCtx>) => ({
      ...input.ctx,
      score: input.ctx.score + 10,
      trail: [...input.ctx.trail, 'skipped'],
    }))

    const run = flow(first, endNow, skipped)
    const result = await run(baseInput)

    expect(result).toEqual({
      type: 'end',
      status: 'blocked',
      message: 'Need manual review',
      ctx: {score: 2, trail: ['first']},
    })
    expect(first).toHaveBeenCalledTimes(1)
    expect(endNow).toHaveBeenCalledTimes(1)
    expect(skipped).not.toHaveBeenCalled()
  })
})

type AskCtx = {
  attempts: number
  trail: string[]
  decision?: string
  human_feedback?: string
}

const askBaseInput: PipeInput<AskCtx> = {
  ctx: {attempts: 0, trail: []},
  runId: 'run-ask-1',
  tickId: 'tick-ask-1',
  task: {
    id: 'task-ask-1',
    title: 'Canonical ask test task',
  },
}

describe('canonical ask primitive', () => {
  it('returns await_feedback when reply is missing', async () => {
    const parse = vi.fn(async (ctx: AskCtx, reply: string) => ({
      ...ctx,
      decision: reply,
    }))
    const requestDecision = ask<AskCtx>('Reply with approve.', parse)
    const result = await requestDecision(askBaseInput)

    expect(result).toEqual({
      type: 'await_feedback',
      prompt: 'Reply with approve.',
      ctx: {attempts: 0, trail: []},
    })
    expect(parse).not.toHaveBeenCalled()
  })

  it('supports invalid reply handling through parser control signals', async () => {
    const requestDecision = ask<AskCtx>(
      ctx => `Attempt ${ctx.attempts + 1}: reply approve.`,
      (ctx, reply) => {
        if (reply.toLowerCase() !== 'approve') {
          return {
            type: 'await_feedback' as const,
            prompt: 'Please reply with "approve".',
            ctx: {
              ...ctx,
              attempts: ctx.attempts + 1,
              trail: [...ctx.trail, `invalid:${reply}`],
            },
          }
        }

        return {
          ...ctx,
          decision: 'approved',
        }
      },
    )

    const result = await requestDecision({
      ...askBaseInput,
      feedback: 'revise',
    })

    expect(result).toEqual({
      type: 'await_feedback',
      prompt: 'Please reply with "approve".',
      ctx: {
        attempts: 1,
        trail: ['invalid:revise'],
      },
    })
  })

  it('returns parsed context when reply is valid', async () => {
    const parse = vi.fn((ctx: AskCtx, reply: string) => ({
      ...ctx,
      decision: reply.toLowerCase(),
    }))
    const requestDecision = ask<AskCtx>('Reply with approve.', parse)
    const result = await requestDecision({
      ...askBaseInput,
      feedback: ' APPROVE ',
    })

    expect(parse).toHaveBeenCalledWith(
      {attempts: 0, trail: []},
      'APPROVE',
    )
    expect(result).toEqual({
      attempts: 0,
      trail: [],
      decision: 'approve',
    })
  })

  it('consumes persisted feedback from context and continues flow on resume', async () => {
    const parse = vi.fn((ctx: AskCtx, reply: string) => ({
      ...ctx,
      decision: reply,
    }))
    const markResumed = vi.fn(async (input: PipeInput<AskCtx>) => ({
      ...input.ctx,
      trail: [...input.ctx.trail, 'after-ask'],
    }))

    const run = flow(ask<AskCtx>('Reply with approve.', parse), markResumed)
    const result = await run({
      ...askBaseInput,
      ctx: {
        attempts: 1,
        trail: ['paused'],
        human_feedback: 'approve',
      },
    })

    expect(parse).toHaveBeenCalledWith(
      {
        attempts: 1,
        trail: ['paused'],
        human_feedback: undefined,
      },
      'approve',
    )
    expect(markResumed).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      attempts: 1,
      trail: ['paused', 'after-ask'],
      decision: 'approve',
      human_feedback: undefined,
    })
  })
})

type DecideCtx = {
  score: number
  decision?: 'approve' | 'revise' | 'fallback'
  trail: string[]
}

const decideBaseInput: PipeInput<DecideCtx> = {
  ctx: {score: 0, trail: []},
  runId: 'run-decide-1',
  tickId: 'tick-decide-1',
  task: {
    id: 'task-decide-1',
    title: 'Canonical decide test task',
  },
}

describe('canonical decide primitive', () => {
  it('executes the selected branch step', async () => {
    const approve = vi.fn(async (input: PipeInput<DecideCtx>) => ({
      ...input.ctx,
      decision: 'approve' as const,
      trail: [...input.ctx.trail, 'approve-branch'],
    }))
    const revise = vi.fn(async (input: PipeInput<DecideCtx>) => ({
      ...input.ctx,
      decision: 'revise' as const,
      trail: [...input.ctx.trail, 'revise-branch'],
    }))

    const run = flow(
      step<DecideCtx>('prepare', ctx => ({
        ...ctx,
        score: 2,
        trail: [...ctx.trail, 'prepared'],
      })),
      decide<DecideCtx, 'approve' | 'revise'>(
        ctx => (ctx.score >= 2 ? 'approve' : 'revise'),
        {approve, revise},
      ),
    )

    const result = await run(decideBaseInput)
    expect(result).toEqual({
      score: 2,
      decision: 'approve',
      trail: ['prepared', 'approve-branch'],
    })
    expect(approve).toHaveBeenCalledTimes(1)
    expect(revise).not.toHaveBeenCalled()
  })

  it('routes unknown selections to explicit fallback when provided', async () => {
    const fallback = vi.fn(async (input: PipeInput<DecideCtx>) => ({
      ...input.ctx,
      decision: 'fallback' as const,
      trail: [...input.ctx.trail, 'fallback-branch'],
    }))

    const run = decide<DecideCtx, string>(
      () => 'unexpected-branch',
      {
        approve: end.done<DecideCtx>('approved'),
      },
      {otherwise: fallback},
    )

    const result = await run(decideBaseInput)
    expect(result).toEqual({
      score: 0,
      decision: 'fallback',
      trail: ['fallback-branch'],
    })
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(fallback).toHaveBeenCalledWith(decideBaseInput)
  })

  it('returns deterministic failed end signal when selection is unmapped', async () => {
    const result = await decide<DecideCtx, string>(
      () => 'unknown',
      {
        approve: end.done<DecideCtx>('approved'),
      },
    )(decideBaseInput)

    expect(result).toEqual({
      type: 'end',
      status: 'failed',
      ctx: {score: 0, trail: []},
      message: 'Unknown branch selected: unknown',
    })
  })
})

type LoopCtx = {
  iterations: number
  trail: string[]
}

const loopBaseInput: PipeInput<LoopCtx> = {
  ctx: {iterations: 0, trail: []},
  runId: 'run-loop-1',
  tickId: 'tick-loop-1',
  task: {
    id: 'task-loop-1',
    title: 'Canonical loop test task',
  },
}

describe('canonical loop primitive', () => {
  it('completes when until condition is met before max', async () => {
    const body = vi.fn(async (input: PipeInput<LoopCtx>) => ({
      ...input.ctx,
      iterations: input.ctx.iterations + 1,
      trail: [...input.ctx.trail, `iteration-${input.ctx.iterations + 1}`],
    }))
    const until = vi.fn((ctx: LoopCtx) => ctx.iterations >= 2)

    const run = loop<LoopCtx>({
      body,
      until,
      max: 5,
    })

    const result = await run(loopBaseInput)
    expect(result).toEqual({
      iterations: 2,
      trail: ['iteration-1', 'iteration-2'],
    })
    expect(body).toHaveBeenCalledTimes(2)
    expect(until).toHaveBeenCalledTimes(3)
  })

  it('invokes onExhausted with latest context when max is reached', async () => {
    const body = vi.fn(async (input: PipeInput<LoopCtx>) => ({
      ...input.ctx,
      iterations: input.ctx.iterations + 1,
      trail: [...input.ctx.trail, `iteration-${input.ctx.iterations + 1}`],
    }))
    const onExhausted = vi.fn(end.blocked<LoopCtx>('Needs review'))

    const run = loop<LoopCtx>({
      body,
      until: () => false,
      max: 2,
      onExhausted,
    })

    const result = await run(loopBaseInput)
    expect(result).toEqual({
      type: 'end',
      status: 'blocked',
      message: 'Needs review',
      ctx: {
        iterations: 2,
        trail: ['iteration-1', 'iteration-2'],
      },
    })
    expect(body).toHaveBeenCalledTimes(2)
    expect(onExhausted).toHaveBeenCalledTimes(1)
    expect(onExhausted).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: {
          iterations: 2,
          trail: ['iteration-1', 'iteration-2'],
        },
      }),
    )
  })

  it('returns deterministic failed end signal when exhausted without onExhausted', async () => {
    const body = vi.fn(async (input: PipeInput<LoopCtx>) => ({
      ...input.ctx,
      iterations: input.ctx.iterations + 1,
      trail: [...input.ctx.trail, `iteration-${input.ctx.iterations + 1}`],
    }))

    const result = await loop<LoopCtx>({
      body,
      until: () => false,
      max: 2,
    })(loopBaseInput)

    expect(result).toEqual({
      type: 'end',
      status: 'failed',
      message: 'Loop exhausted before completion',
      ctx: {
        iterations: 2,
        trail: ['iteration-1', 'iteration-2'],
      },
    })
    expect(body).toHaveBeenCalledTimes(2)
  })
})

type WriteCtx = {
  score: number
  trail: string[]
}

const writeBaseInput: PipeInput<WriteCtx> = {
  ctx: {score: 3, trail: []},
  runId: 'run-write-1',
  tickId: 'tick-write-1',
  task: {
    id: 'task-write-1',
    title: 'Canonical write test task',
  },
}

describe('canonical write primitive', () => {
  it('forwards rendered string output through configured writePage service', async () => {
    const writePage = vi.fn(async () => undefined)
    const render = vi.fn((ctx: WriteCtx) => `# score ${ctx.score}`)

    const result = await write<WriteCtx>(render)({
      ...writeBaseInput,
      writePage,
    })

    expect(result).toEqual(writeBaseInput.ctx)
    expect(render).toHaveBeenCalledWith(writeBaseInput.ctx)
    expect(writePage).toHaveBeenCalledTimes(1)
    expect(writePage).toHaveBeenCalledWith('# score 3')
  })

  it('forwards rendered markdown object output through configured writePage service', async () => {
    const writePage = vi.fn(async () => undefined)

    const result = await write<WriteCtx>(ctx => ({
      markdown: `# score ${ctx.score}`,
      body: `trail=${ctx.trail.length}`,
    }))({
      ...writeBaseInput,
      writePage,
    })

    expect(result).toEqual(writeBaseInput.ctx)
    expect(writePage).toHaveBeenCalledTimes(1)
    expect(writePage).toHaveBeenCalledWith({
      markdown: '# score 3',
      body: 'trail=0',
    })
  })

  it('does not interrupt flow sequencing after write emits output', async () => {
    const outputs: unknown[] = []
    const run = flow(
      write<WriteCtx>(ctx => `emitted:${ctx.score}`),
      step<WriteCtx>('increment', ctx => ({
        ...ctx,
        score: ctx.score + 1,
        trail: [...ctx.trail, 'after-write'],
      })),
    )

    const result = await run({
      ...writeBaseInput,
      writePage: async output => {
        outputs.push(output)
      },
    })

    expect(outputs).toEqual(['emitted:3'])
    expect(result).toEqual({
      score: 4,
      trail: ['after-write'],
    })
  })
})

type EndCtx = {
  score: number
  trail: string[]
}

const endBaseInput: PipeInput<EndCtx> = {
  ctx: {score: 1, trail: ['prepared']},
  runId: 'run-end-1',
  tickId: 'tick-end-1',
  task: {
    id: 'task-end-1',
    title: 'Canonical end test task',
  },
}

describe('canonical end primitive', () => {
  it('supports end.done() terminal control', async () => {
    const result = await end.done<EndCtx>()(endBaseInput)

    expect(result).toEqual({
      type: 'end',
      status: 'done',
      ctx: {score: 1, trail: ['prepared']},
      message: undefined,
    })
  })

  it('supports end.blocked() terminal control', async () => {
    const result = await end.blocked<EndCtx>('Waiting on external approval')(
      endBaseInput,
    )

    expect(result).toEqual({
      type: 'end',
      status: 'blocked',
      ctx: {score: 1, trail: ['prepared']},
      message: 'Waiting on external approval',
    })
  })

  it('supports end.failed(message) terminal control', async () => {
    const result = await end.failed<EndCtx>('Validation failed')(endBaseInput)

    expect(result).toEqual({
      type: 'end',
      status: 'failed',
      ctx: {score: 1, trail: ['prepared']},
      message: 'Validation failed',
    })
  })
})
