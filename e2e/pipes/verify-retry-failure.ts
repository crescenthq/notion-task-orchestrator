import {definePipe, end, flow, step} from '../../src/factory/canonical'

export default definePipe({
  id: 'verify-retry-failure',
  initial: {attempts: 0},
  run: flow(
    step('fragile', ctx => ({...ctx, attempts: Number(ctx.attempts ?? 0) + 1})),
    end.failed('forced failure from definePipe verification fixture'),
  ),
})
