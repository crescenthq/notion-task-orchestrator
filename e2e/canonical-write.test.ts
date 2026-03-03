import {describe, expect, it} from 'vitest'
import {definePipe, flow, step, write, type PipeInput} from '../src/factory/canonical'

type WriteE2ECtx = {
  score: number
  trail: string[]
  summary?: string
}

function createInput(
  ctx: WriteE2ECtx,
  writePage?: PipeInput<WriteE2ECtx>['writePage'],
): PipeInput<WriteE2ECtx> {
  return {
    ctx,
    runId: 'run-write-e2e-1',
    tickId: 'tick-write-e2e-1',
    writePage,
    task: {
      id: 'task-write-e2e-1',
      title: 'Canonical write e2e',
    },
  }
}

describe('canonical write e2e scenarios', () => {
  it('scenario: write emits string output and flow continues', async () => {
    const outputs: unknown[] = []
    const pipe = definePipe({
      id: 'write-e2e-string',
      initial: {score: 0, trail: [] as string[]},
      run: flow(
        step<WriteE2ECtx>('prepare', ctx => ({
          ...ctx,
          score: 2,
          trail: [...ctx.trail, 'prepared'],
        })),
        write<WriteE2ECtx>(ctx => `score=${ctx.score}`),
        step<WriteE2ECtx>('finalize', ctx => ({
          ...ctx,
          summary: `done:${ctx.score}`,
          trail: [...ctx.trail, 'finalized'],
        })),
      ),
    })

    const result = await pipe.run(
      createInput({score: 0, trail: []}, async output => {
        outputs.push(output)
      }),
    )

    expect(outputs).toEqual(['score=2'])
    expect(result).toEqual({
      score: 2,
      summary: 'done:2',
      trail: ['prepared', 'finalized'],
    })
  })

  it('scenario: write emits markdown object output', async () => {
    const outputs: unknown[] = []
    const pipe = definePipe({
      id: 'write-e2e-markdown',
      initial: {score: 0, trail: [] as string[]},
      run: flow(
        step<WriteE2ECtx>('prepare', ctx => ({
          ...ctx,
          score: 4,
          trail: [...ctx.trail, 'prepared'],
        })),
        write<WriteE2ECtx>(ctx => ({
          markdown: `# score ${ctx.score}`,
          body: `trail=${ctx.trail.length}`,
        })),
      ),
    })

    const result = await pipe.run(
      createInput({score: 0, trail: []}, async output => {
        outputs.push(output)
      }),
    )

    expect(outputs).toEqual([
      {
        markdown: '# score 4',
        body: 'trail=1',
      },
    ])
    expect(result).toEqual({
      score: 4,
      trail: ['prepared'],
    })
  })
})
