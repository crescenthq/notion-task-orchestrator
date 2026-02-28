import {describe, expect, it} from 'vitest'
import {compileExpressiveFactory, end, step} from './expressive'

describe('expressive end compilation', () => {
  it('compiles end primitives into terminal runtime states', () => {
    const compiled = compileExpressiveFactory({
      id: 'compiled-end-terminal-factory',
      start: 'done_terminal',
      context: {},
      states: {
        done_terminal: end({status: 'done'}),
        blocked_terminal: end({status: 'blocked'}),
        failed_terminal: end({status: 'failed'}),
      },
    })

    expect(compiled.states.done_terminal).toEqual({type: 'done'})
    expect(compiled.states.blocked_terminal).toEqual({type: 'blocked'})
    expect(compiled.states.failed_terminal).toEqual({type: 'failed'})
  })

  it('preserves terminal routing targets for compiled output paths', () => {
    const compiled = compileExpressiveFactory({
      id: 'compiled-end-routing-factory',
      start: 'work',
      context: {},
      states: {
        work: step({
          run: async () => ({status: 'done'}),
          on: {
            done: 'complete',
            feedback: 'needs_input',
            failed: 'error_out',
          },
        }),
        complete: end({status: 'done'}),
        needs_input: end({status: 'blocked'}),
        error_out: end({status: 'failed'}),
      },
    })

    const workState = compiled.states.work
    if (!workState || workState.type !== 'action') {
      throw new Error('Expected compiled action state for `work`')
    }

    expect(workState.on.done).toBe('complete')
    expect(workState.on.feedback).toBe('needs_input')
    expect(workState.on.failed).toBe('error_out')
    expect(compiled.states.complete).toEqual({type: 'done'})
    expect(compiled.states.needs_input).toEqual({type: 'blocked'})
    expect(compiled.states.error_out).toEqual({type: 'failed'})
  })
})
