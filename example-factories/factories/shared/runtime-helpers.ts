import { agent, select, until } from "notionflow";

export const enrichContext = agent(async ({ ctx }) => ({
  status: "done",
  data: { ...ctx, enriched: true },
}));

export const chooseRoute = select(({ ctx }) => (ctx.enriched ? "finish" : "retry"));

export const loopComplete = until(({ iteration }) => iteration >= 1);
