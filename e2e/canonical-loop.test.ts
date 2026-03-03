import {describe, expect, it} from 'vitest'
import {definePipe, flow, loop, step, type PipeInput} from '../src/factory/canonical'

type LoopE2ECtx = {
  count: number
  trail: string[]
  summary?: string
}

function createInput(
  ctx: LoopE2ECtx,
  tickId = 'tick-loop-e2e-1',
): PipeInput<LoopE2ECtx> {
  return {
    ctx,
    runId: 'run-loop-e2e-1',
    tickId,
    task: {
      id: 'task-loop-e2e-1',
      title: 'Canonical loop e2e',
    },
  }
}

describe('canonical loop e2e scenarios', () => {
  it('scenario: bounded loop completes before exhaustion', async () => {
    const increment = step<LoopE2ECtx>('increment', ctx => ({
      ...ctx,
      count: ctx.count + 1,
      trail: [...ctx.trail, `iter-${ctx.count + 1}`],
    }))

    const pipe = definePipe({
      id: 'loop-e2e-complete',
      initial: {count: 0, trail: [] as string[]},
      run: flow(
        loop<LoopE2ECtx>({
          body: increment,
          until: ctx => ctx.count >= 2,
          max: 5,
        }),
        step<LoopE2ECtx>('mark-complete', ctx => ({
          ...ctx,
          summary: `completed:${ctx.count}`,
        })),
      ),
    })

    const result = await pipe.run(createInput({count: 0, trail: []}))
    expect(result).toEqual({
      count: 2,
      trail: ['iter-1', 'iter-2'],
      summary: 'completed:2',
    })
  })

  it('scenario: bounded loop exhaustion produces deterministic failure', async () => {
    const increment = step<LoopE2ECtx>('increment', ctx => ({
      ...ctx,
      count: ctx.count + 1,
      trail: [...ctx.trail, `iter-${ctx.count + 1}`],
    }))

    const pipe = definePipe({
      id: 'loop-e2e-exhausted',
      initial: {count: 0, trail: [] as string[]},
      run: loop<LoopE2ECtx>({
        body: increment,
        until: () => false,
        max: 2,
      }),
    })

    const result = await pipe.run(
      createInput({count: 0, trail: []}, 'tick-loop-e2e-2'),
    )
    expect(result).toEqual({
      type: 'end',
      status: 'failed',
      message: 'Loop exhausted before completion',
      ctx: {
        count: 2,
        trail: ['iter-1', 'iter-2'],
      },
    })
  })
})
