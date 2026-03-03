import {ask, definePipe, end, flow, step} from '../../src/factory/canonical'

export default definePipe({
  id: 'verify-resume-budget',
  initial: {
    step_a_runs: 0,
    step_b_runs: 0,
  },
  run: flow(
    step('step_one', ctx => ({
      ...ctx,
      step_a_runs: Number(ctx.step_a_runs ?? 0) + 1,
      last_completed_state: 'step_one',
    })),
    ask('checkpoint-ask-1', (ctx, reply) => ({
      ...ctx,
      first_feedback: reply,
    })),
    step('step_two', ctx => ({
      ...ctx,
      step_b_runs: Number(ctx.step_b_runs ?? 0) + 1,
      last_completed_state: 'step_two',
    })),
    ask('checkpoint-ask-2', (ctx, reply) => ({
      ...ctx,
      second_feedback: reply,
    })),
    end.done(),
  ),
})
