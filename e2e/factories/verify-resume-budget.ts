type ResumeBudgetInput = {
  stateId: string;
  ctx: Record<string, unknown>;
};

const step = async ({ stateId, ctx }: ResumeBudgetInput) => ({
  status: "done",
  data: { ...ctx, last_completed_state: String(stateId) },
});

export default {
  id: "verify-resume-budget",
  start: "step_one",
  context: {},
  states: {
    step_one: {
      type: "action",
      agent: step,
      on: { done: "step_two", failed: "failed" },
    },
    step_two: {
      type: "action",
      agent: step,
      on: { done: "step_three", failed: "failed" },
    },
    step_three: {
      type: "action",
      agent: step,
      on: { done: "done", failed: "failed" },
    },
    done: { type: "done" },
    failed: { type: "failed" },
  },
};
