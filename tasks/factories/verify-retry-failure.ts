const alwaysFail = async ({ tickId, attempt }) => ({
  status: "failed",
  message: `forced failure on tick ${String(tickId)} attempt ${Number(attempt)}`,
});

export default {
  id: "verify-retry-failure",
  start: "fragile",
  context: {},
  states: {
    fragile: {
      type: "action",
      agent: alwaysFail,
      retries: { max: 2 },
      on: { done: "done", failed: "failed" },
    },
    done: { type: "done" },
    failed: { type: "failed" },
  },
};
