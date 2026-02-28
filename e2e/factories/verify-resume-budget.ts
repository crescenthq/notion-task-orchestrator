import {definePipe, end, flow, step} from '../../src/factory/canonical'

export default definePipe({
  id: 'verify-resume-budget',
  initial: {},
  run: flow(
    step('step_one', ctx => ({...ctx, last_completed_state: 'step_one'})),
    step('step_two', ctx => ({...ctx, last_completed_state: 'step_two'})),
    step('step_three', ctx => ({...ctx, last_completed_state: 'step_three'})),
    end.done(),
  ),
})
