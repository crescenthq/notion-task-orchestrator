import { defineFactory } from "notionflow";
import { chooseRoute, enrichContext, loopComplete } from "./shared/runtime-helpers";

export default defineFactory({
  id: "shared-helper-demo",
  start: "loop",
  context: { enriched: false },
  states: {
    loop: {
      type: "loop",
      body: "enrich",
      maxIterations: 3,
      until: loopComplete,
      on: {
        continue: "enrich",
        done: "done",
        exhausted: "failed",
      },
    },
    enrich: {
      type: "action",
      agent: enrichContext,
      on: {
        done: "route",
        failed: "failed",
      },
    },
    route: {
      type: "orchestrate",
      select: chooseRoute,
      on: {
        finish: "done",
        retry: "loop",
      },
    },
    done: { type: "done" },
    failed: { type: "failed" },
  },
});
