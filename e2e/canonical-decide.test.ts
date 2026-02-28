import {describe, expect, it} from 'vitest'
import {decide, definePipe, end, flow, step, type PipeInput} from '../src/factory/canonical'

type DecideE2ECtx = {
  score: number
  decision?: 'approved' | 'revised'
  trail: string[]
}

function createInput(
  ctx: DecideE2ECtx,
  tickId = 'tick-decide-e2e-1',
): PipeInput<DecideE2ECtx> {
  return {
    ctx,
    runId: 'run-decide-e2e-1',
    tickId,
    task: {
      id: 'task-decide-e2e-1',
      title: 'Canonical decide e2e',
    },
  }
}

describe('canonical decide e2e scenarios', () => {
  it('scenario: selected branch flow executes successfully', async () => {
    const approveBranch = flow(
      step<DecideE2ECtx>('approve-prepare', ctx => ({
        ...ctx,
        trail: [...ctx.trail, 'approve:prepare'],
      })),
      step<DecideE2ECtx>('approve-finalize', ctx => ({
        ...ctx,
        decision: 'approved',
        trail: [...ctx.trail, 'approve:finalize'],
      })),
    )

    const reviseBranch = flow(
      step<DecideE2ECtx>('revise-note', ctx => ({
        ...ctx,
        decision: 'revised',
        trail: [...ctx.trail, 'revise'],
      })),
    )

    const pipe = definePipe({
      id: 'decide-e2e-success',
      initial: {score: 0, trail: [] as string[]},
      run: flow(
        step<DecideE2ECtx>('prepare', ctx => ({
          ...ctx,
          score: 2,
          trail: [...ctx.trail, 'prepared'],
        })),
        decide<DecideE2ECtx, 'approve' | 'revise'>(
          ctx => (ctx.score >= 2 ? 'approve' : 'revise'),
          {
            approve: approveBranch,
            revise: reviseBranch,
          },
        ),
      ),
    })

    const result = await pipe.run(createInput({score: 0, trail: []}))
    expect(result).toEqual({
      score: 2,
      decision: 'approved',
      trail: ['prepared', 'approve:prepare', 'approve:finalize'],
    })
  })

  it('scenario: unmapped branch deterministically fails without fallback', async () => {
    const pipe = definePipe({
      id: 'decide-e2e-unmapped',
      initial: {score: 0, trail: [] as string[]},
      run: flow(
        step<DecideE2ECtx>('prepare', ctx => ({
          ...ctx,
          trail: [...ctx.trail, 'prepared'],
        })),
        decide<DecideE2ECtx, string>(
          () => 'non-existent-branch',
          {
            approve: end.done<DecideE2ECtx>('approved'),
          },
        ),
      ),
    })

    const result = await pipe.run(createInput({score: 0, trail: []}, 'tick-2'))
    expect(result).toEqual({
      type: 'end',
      status: 'failed',
      ctx: {
        score: 0,
        trail: ['prepared'],
      },
      message: 'Unknown branch selected: non-existent-branch',
    })
  })
})
