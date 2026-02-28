type HappyInput = {
  ctx: Record<string, unknown>
}

const draftPlan = async ({ctx}: HappyInput) => ({
  status: 'done',
  data: {...ctx, happy_step: 'plan-created'},
})

export default {
  id: 'verify-happy',
  start: 'plan',
  context: {},
  states: {
    plan: {
      type: 'action',
      agent: draftPlan,
      on: {done: 'done', failed: 'failed'},
    },
    done: {type: 'done'},
    failed: {type: 'failed'},
  },
}
