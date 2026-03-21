import {definePipe, end, flow, step} from '../../src/pipe/canonical'

export default definePipe({
  id: 'verify-happy',
  initial: {},
  run: flow(
    step('plan', ctx => ({...ctx, happy_step: 'plan-created'})),
    end.done(),
  ),
})
