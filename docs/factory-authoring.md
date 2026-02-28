# Factory Authoring Guide

## Factory Shape

A factory is a default export state machine.

```ts
import { defineFactory } from "notionflow";

export default defineFactory({
  id: "my-factory",
  start: "start",
  context: {},
  states: {
    start: {
      type: "action",
      agent: async ({ ctx }) => ({ status: "done", data: ctx }),
      on: { done: "done", failed: "failed" },
    },
    done: { type: "done" },
    failed: { type: "failed" },
  },
});
```

## Local Project Workflow

1. Initialize project structure.

```bash
npx notionflow init
```

2. Scaffold a factory.

```bash
npx notionflow factory create --id my-factory --skip-notion-board
```

3. Declare factory file in `notionflow.config.ts`.

```ts
import { defineConfig } from "notionflow";

export default defineConfig({
  factories: ["./factories/my-factory.ts"],
});
```

4. Validate project context and auth.

```bash
npx notionflow doctor
```

5. Execute tasks with `run` or `tick` directly from local files.

## Runtime Hooks And Shared Modules

Runtime hooks may be imported from shared modules. This is supported:

- `agent`
- `select`
- `until`

Example shared runtime helper module:

```ts
import { agent, select, until } from "notionflow";

export const enrich = agent(async ({ ctx }) => ({
  status: "done",
  data: { ...ctx, enriched: true },
}));

export const route = select(({ ctx }) => (ctx.enriched ? "finish" : "retry"));

export const shouldStop = until(({ iteration }) => iteration >= 1);
```

Factory using imported helpers:

```ts
import { defineFactory } from "notionflow";
import { enrich, route, shouldStop } from "./shared/runtime-helpers";

export default defineFactory({
  id: "shared-helper-demo",
  start: "run_loop",
  context: { enriched: false },
  states: {
    run_loop: {
      type: "loop",
      body: "enrich",
      maxIterations: 3,
      until: shouldStop,
      on: { continue: "enrich", done: "done", exhausted: "failed" },
    },
    enrich: {
      type: "action",
      agent: enrich,
      on: { done: "route", failed: "failed" },
    },
    route: {
      type: "orchestrate",
      select: route,
      on: { finish: "done", retry: "run_loop" },
    },
    done: { type: "done" },
    failed: { type: "failed" },
  },
});
```

## Validation Rules

- `start` state must exist
- transition targets must exist
- action states require `on.done` and `on.failed`
- loop states require `on.continue`, `on.done`, `on.exhausted`
- loop `on.continue` must equal `body`
- declared factories in config must exist on disk
- duplicate factory IDs across declared files fail startup

## Authoring Tips

- Keep context JSON-serializable
- Keep `id` stable after tasks are in-flight
- prefer additive context writes (`data`) over destructive replacements
- use retries only for transient failures

## Smoke Test

```bash
npx notionflow run --task <notion_page_id>
```

Or queue-driven:

```bash
npx notionflow tick --factory <factory-id>
```
