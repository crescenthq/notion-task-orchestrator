import {definePipe, end, flow, loop, step} from '../../src/factory/canonical'

export default definePipe({
  id: 'verify-loop',
  initial: {loop_iterations_seen: 0},
  run: flow(
    loop({
      body: step('iterate', ctx => ({
        ...ctx,
        loop_iterations_seen: Number(ctx.loop_iterations_seen ?? 0) + 1,
      })),
      until: ctx => Number(ctx.loop_iterations_seen ?? 0) >= 2,
      max: 4,
      onExhausted: end.failed('Loop exhausted during verification'),
    }),
    end.done(),
  ),
})
