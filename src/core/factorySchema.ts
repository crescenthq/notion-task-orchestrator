import { z } from "zod";

const transitionMapSchema = z.record(z.string().min(1), z.string().min(1));

const retryBackoffSchema = z
  .object({
    strategy: z.enum(["fixed", "exponential"]).optional(),
    ms: z.number().int().min(0),
    maxMs: z.number().int().positive().optional(),
  })
  .strict();

const retrySchema = z.object({
  max: z.number().int().min(0).optional(),
  maxRetries: z.number().int().min(0).optional(),
  backoff: retryBackoffSchema.optional(),
}).strict().superRefine((retry, ctx) => {
  const hasMax = typeof retry.max === "number";
  const hasLegacyMax = typeof retry.maxRetries === "number";
  if (hasMax === hasLegacyMax) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Retry config must define exactly one of `max` or `maxRetries`",
      path: ["max"],
    });
  }
}).transform((retry) => ({
  max: retry.max ?? retry.maxRetries ?? 0,
  backoff: retry.backoff,
}));

const actionStateSchema = z.object({
  type: z.literal("action"),
  agent: z.function(),
  on: transitionMapSchema,
  retries: retrySchema.optional(),
}).strict();

const orchestrateStateSchema = z.object({
  type: z.literal("orchestrate"),
  agent: z.function().optional(),
  select: z.function().optional(),
  on: transitionMapSchema,
}).strict().superRefine((state, ctx) => {
  if (!state.agent && !state.select) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Orchestrate state must define `agent` or `select`",
      path: ["agent"],
    });
  }
});

const loopStateSchema = z.object({
  type: z.literal("loop"),
  body: z.string().min(1),
  maxIterations: z.number().int().positive(),
  until: z.union([z.string().min(1), z.function()]).optional(),
  on: transitionMapSchema,
}).strict();

const feedbackStateSchema = z.object({
  type: z.literal("feedback"),
  resume: z.union([z.literal("previous"), z.string().min(1)]).optional(),
}).strict();

const doneStateSchema = z.object({
  type: z.literal("done"),
}).strict();

const failedStateSchema = z.object({
  type: z.literal("failed"),
}).strict();

const blockedStateSchema = z.object({
  type: z.literal("blocked"),
}).strict();

export const factoryStateSchema = z.discriminatedUnion("type", [
  actionStateSchema,
  orchestrateStateSchema,
  loopStateSchema,
  feedbackStateSchema,
  doneStateSchema,
  failedStateSchema,
  blockedStateSchema,
]);

const guardsSchema = z.record(z.string().min(1), z.function());

export const factorySchema = z.object({
  id: z.string().min(1),
  start: z.string().min(1),
  context: z.record(z.string(), z.unknown()).optional(),
  states: z.record(z.string().min(1), factoryStateSchema),
  guards: guardsSchema.optional(),
}).strict().superRefine((factory, ctx) => {
  const stateIds = new Set(Object.keys(factory.states));

  if (stateIds.size === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Factory must define at least one state",
      path: ["states"],
    });
    return;
  }

  if (!stateIds.has(factory.start)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Factory start state \`${factory.start}\` does not exist`,
      path: ["start"],
    });
  }

  for (const [stateId, state] of Object.entries(factory.states)) {
    if (state.type === "action" || state.type === "orchestrate" || state.type === "loop") {
      if (Object.keys(state.on).length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `State \`${stateId}\` requires a non-empty \`on\` transition map`,
          path: ["states", stateId, "on"],
        });
      }

      for (const [event, target] of Object.entries(state.on)) {
        if (!stateIds.has(target)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `State \`${stateId}\` maps event \`${event}\` to missing target \`${target}\``,
            path: ["states", stateId, "on", event],
          });
        }
      }
    }

    if (state.type === "loop") {
      for (const requiredEvent of ["continue", "done", "exhausted"]) {
        if (!state.on[requiredEvent]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Loop state \`${stateId}\` must define \`on.${requiredEvent}\` transition`,
            path: ["states", stateId, "on", requiredEvent],
          });
        }
      }

      if (state.on.continue && state.on.continue !== state.body) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Loop state \`${stateId}\` must route \`on.continue\` to body state \`${state.body}\``,
          path: ["states", stateId, "on", "continue"],
        });
      }

      if (!stateIds.has(state.body)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Loop state \`${stateId}\` references missing body state \`${state.body}\``,
          path: ["states", stateId, "body"],
        });
      }

      if (typeof state.until === "string") {
        if (!factory.guards || !factory.guards[state.until]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Loop state \`${stateId}\` references missing guard \`${state.until}\``,
            path: ["states", stateId, "until"],
          });
        }
      }
    }

    if (state.type === "feedback" && state.resume && state.resume !== "previous" && !stateIds.has(state.resume)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Feedback state \`${stateId}\` resume target \`${state.resume}\` does not exist`,
        path: ["states", stateId, "resume"],
      });
    }
  }
});

export type FactoryDefinition = z.infer<typeof factorySchema>;
