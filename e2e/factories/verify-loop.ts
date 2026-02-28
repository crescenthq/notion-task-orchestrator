type LoopInput = {
  ctx: Record<string, unknown>;
};

const iterate = async ({ ctx }: LoopInput) => ({
  status: "done",
  data: { loop_iterations_seen: Number(ctx.loop_iterations_seen ?? 0) + 1 },
});

const loopDone = ({ ctx }: LoopInput) => Number(ctx.loop_iterations_seen ?? 0) >= 2;

export default {
  id: "verify-loop",
  start: "loop_gate",
  context: { loop_iterations_seen: 0 },
  guards: { loopDone },
  states: {
    loop_gate: {
      type: "loop",
      body: "work",
      maxIterations: 4,
      until: "loopDone",
      on: { continue: "work", done: "done", exhausted: "failed" },
    },
    work: {
      type: "action",
      agent: iterate,
      on: { done: "loop_gate", failed: "failed" },
    },
    done: { type: "done" },
    failed: { type: "failed" },
  },
};
