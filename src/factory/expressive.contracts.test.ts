import {describe, expect, it} from 'vitest'
import type {FactoryDefinition} from '../core/factorySchema'
import type {ActionResult} from './helpers'
import {
  ask,
  compileExpressiveFactory,
  end,
  loop,
  publish,
  retry,
  route,
  step,
  type AskPrimitiveConfig,
  type CompileFactoryResult,
  type CompiledFactoryDefinition,
  type EndPrimitiveConfig,
  type LoopPrimitiveConfig,
  type PublishPrimitiveConfig,
  type RetryPrimitiveConfig,
  type RoutePrimitiveConfig,
  type StepPrimitiveConfig,
} from './expressive'

type TaskContext = {
  score: number
}

describe('expressive contracts', () => {
  it('provides typed primitive contracts for status routing and page output', async () => {
    const stepConfig: StepPrimitiveConfig<TaskContext> = {
      run: async ({ctx}) => {
        const result: ActionResult<TaskContext> = {
          status: 'feedback',
          data: {score: ctx.score + 1},
          page: {markdown: `score=${ctx.score + 1}`},
        }
        return result
      },
      on: {
        done: 'done',
        feedback: 'ask',
        failed: 'failed',
      },
    }

    const askConfig: AskPrimitiveConfig<TaskContext> = {
      prompt: ({ctx}) => `Current score: ${ctx.score}`,
      parse: reply => ({
        status: reply.trim() ? 'done' : 'feedback',
        data: {score: 1},
      }),
      on: {
        done: 'route',
        feedback: 'ask',
        failed: 'failed',
      },
      resume: 'previous',
    }

    const routeConfig: RoutePrimitiveConfig<TaskContext, 'approve' | 'revise'> = {
      select: ({ctx}) => (ctx.score > 1 ? 'approve' : 'revise'),
      on: {approve: 'done', revise: 'step'},
    }

    const loopConfig: LoopPrimitiveConfig<TaskContext> = {
      body: 'step',
      maxIterations: 3,
      until: ({iteration}) => iteration >= 2,
      on: {continue: 'step', done: 'done', exhausted: 'failed'},
    }

    const retryConfig: RetryPrimitiveConfig = {
      max: 2,
      backoff: {strategy: 'fixed', ms: 25},
    }

    const publishConfig: PublishPrimitiveConfig<TaskContext> = {
      render: async ({ctx}) => ({markdown: `# Score ${ctx.score}`}),
      on: {done: 'done', failed: 'failed'},
    }

    const endConfig: EndPrimitiveConfig<'done'> = {status: 'done'}

    const stepNode = step(stepConfig)
    const askNode = ask(askConfig)
    const routeNode = route(routeConfig)
    const loopNode = loop(loopConfig)
    const retryNode = retry(retryConfig)
    const publishNode = publish(publishConfig)
    const endNode = end(endConfig)

    expect(stepNode.primitive).toBe('step')
    expect(askNode.primitive).toBe('ask')
    expect(routeNode.primitive).toBe('route')
    expect(loopNode.primitive).toBe('loop')
    expect(retryNode.primitive).toBe('retry')
    expect(publishNode.primitive).toBe('publish')
    expect(endNode.primitive).toBe('end')

    const runtimeResult = await stepConfig.run({ctx: {score: 0}})
    expect(runtimeResult.status).toBe('feedback')
    expect(runtimeResult.page).toEqual({markdown: 'score=1'})
  })

  it('anchors compiler result types to FactoryDefinition semantics', () => {
    const compiledFactory: CompiledFactoryDefinition = {
      id: 'compiled-typed-factory',
      start: 'done',
      states: {
        done: {type: 'done'},
      },
    }

    const runtimeFactory: FactoryDefinition = compiledFactory
    const compileResult: CompileFactoryResult = {
      factory: runtimeFactory,
      start: runtimeFactory.start,
      states: runtimeFactory.states,
      guards: runtimeFactory.guards,
    }

    expect(compileResult.factory.id).toBe('compiled-typed-factory')
    expect(Object.keys(compileResult.states)).toEqual(['done'])
  })

  it('compiles step primitives into schema-valid action states', () => {
    const compiled = compileExpressiveFactory({
      id: 'compiled-step-factory',
      start: 'work',
      context: {score: 0},
      states: {
        work: step({
          run: async ({ctx}: {ctx: TaskContext}) => ({
            status: 'feedback',
            data: {score: ctx.score + 1},
          }),
          on: {
            done: 'done',
            feedback: 'await_human',
            failed: 'failed',
          },
        }),
        done: {type: 'done'},
        await_human: {type: 'blocked'},
        failed: {type: 'failed'},
      },
    })

    const workState = compiled.states.work
    if (!workState || workState.type !== 'action') {
      throw new Error('Expected compiled action state for `work`')
    }

    expect(workState.on.done).toBe('done')
    expect(workState.on.feedback).toBe('await_human')
    expect(workState.on.failed).toBe('failed')
  })
})
