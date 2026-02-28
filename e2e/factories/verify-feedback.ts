import {ask, definePipe, end, flow} from '../../src/factory/canonical'

export default definePipe({
  id: 'verify-feedback',
  initial: {feedback_attempts: 0},
  run: flow(
    ask(
      'Please confirm this run can continue.',
      (ctx, reply) => ({
        ...ctx,
        feedback_attempts: Number(ctx.feedback_attempts ?? 0) + 1,
        feedback_value: reply,
      }),
    ),
    end.done(),
  ),
})
