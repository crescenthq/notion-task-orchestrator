const askForFeedback = async ({ ctx }) => {
  const attempts = Number(ctx.feedback_attempts ?? 0) + 1;
  if (!ctx.human_feedback) {
    return {
      status: "feedback",
      message: "Please confirm this run can continue.",
      data: { feedback_attempts: attempts },
    };
  }

  return {
    status: "done",
    data: { feedback_attempts: attempts, feedback_value: String(ctx.human_feedback) },
  };
};

export default {
  id: "verify-feedback",
  start: "ask",
  context: { feedback_attempts: 0 },
  states: {
    ask: {
      type: "action",
      agent: askForFeedback,
      on: { done: "done", feedback: "await_human", failed: "failed" },
    },
    await_human: { type: "feedback", resume: "previous" },
    done: { type: "done" },
    failed: { type: "failed" },
  },
};
