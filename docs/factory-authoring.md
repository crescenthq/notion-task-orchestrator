# Factory Authoring Guide

This guide explains how to design, implement, validate, and operate TypeScript factories in NotionFlow.

## What Is a Factory?

A factory is a state machine that runs task logic and routes between states.

A factory is a single TypeScript file with a default export.

```ts
export default {
  id: "my-factory",
  start: "start",
  context: {},
  states: {
    // ...state definitions...
  },
};
```

## Quick Start

1. Create a scaffold:

```bash
npx notionflow factory create --id my-factory --skip-notion-board
```

2. Edit the generated file in:

```text
~/.config/notionflow/workflows/my-factory.ts
```

3. Install the factory:

```bash
npx notionflow factory install --path ~/.config/notionflow/workflows/my-factory.ts
```

4. Validate registration:

```bash
npx notionflow factory list
```

## Factory Contract

Top-level fields:

- `id`: unique factory id
- `start`: starting state id
- `context` (optional): initial context object
- `states`: state map
- `guards` (optional): named guard functions for loops

## State Types

### Action State

Use for work execution.

```ts
const draft = async ({ task, ctx, attempt }) => {
  // Perform work
  return {
    status: "done",
    data: { draft: "...", attempt_used: attempt },
  };
};

const factory = {
  // ...
  states: {
    draft: {
      type: "action",
      agent: draft,
      on: { done: "done", feedback: "await_human", failed: "failed" },
      retries: {
        max: 2,
        backoff: { strategy: "exponential", ms: 500, maxMs: 5000 },
      },
    },
  },
};
```

Required:

- `on.done`
- `on.failed`

Agent return shape:

- `status`: `"done" | "feedback" | "failed"`
- `data?`: object merged into context
- `message?`: string for logs/comments

### Orchestrate State

Use for branching/routing.

#### Option A: deterministic `select`

```ts
const chooseRoute = ({ ctx }) => (ctx.score >= 80 ? "approve" : "revise");

route: {
  type: "orchestrate",
  select: chooseRoute,
  on: { approve: "done", revise: "revise" },
}
```

#### Option B: agent-driven routing

```ts
const routeAgent = async ({ ctx }) => ({
  status: "done",
  data: { event: ctx.approved ? "approve" : "revise" },
});

route: {
  type: "orchestrate",
  agent: routeAgent,
  on: { approve: "done", revise: "revise" },
}
```

### Loop State

Use to enforce bounded repetition.

```ts
const qualityReached = ({ ctx }) => Number(ctx.score ?? 0) >= 3;

review_loop: {
  type: "loop",
  body: "review",
  maxIterations: 5,
  until: "qualityReached",
  on: {
    continue: "review",
    done: "done",
    exhausted: "failed",
  },
}
```

Rules:

- `on.continue`, `on.done`, `on.exhausted` are required
- `on.continue` must equal `body`
- `body` state must exist
- if `until` is a string, matching guard must exist in `guards`

### Feedback State

Use to pause for human input.

```ts
await_human: { type: "feedback", resume: "previous" }
```

Resume behavior:

- `resume: "previous"`: return to the state that requested feedback
- `resume: "state_id"`: resume from a specific state

### Terminal States

```ts
done: { type: "done" }
failed: { type: "failed" }
blocked: { type: "blocked" }
```

## Runtime Input/Output Reference

### Action Agent Input

```ts
{
  task: {
    id: string,
    title: string,
    prompt: string,
    context: string,
  },
  ctx: Record<string, unknown>,
  stateId: string,
  runId: string,
  tickId: string,
  attempt: number,
}
```

### Orchestrate `select` Input

```ts
{
  task,
  ctx,
  stateId,
  runId,
  tickId,
}
```

### Loop Guard Input

```ts
{
  task,
  ctx,
  stateId,
  runId,
  tickId,
  iteration: number,
}
```

## Locality Rule For Runtime Hooks

Runtime hooks must be declared in the same factory file:

- `agent`
- `select`
- `until` (function form)

Do not bind imported functions directly to these runtime slots.

Valid pattern:

- import utility helpers
- keep runtime hook function declarations local

## Context Design Best Practices

- Use stable key names per stage (`plan`, `draft`, `score`, `human_feedback`).
- Keep values JSON-serializable.
- Prefer additive context updates over overwriting unrelated keys.
- Treat context as shallow-merge; avoid assuming deep merges.

## Retry Design Best Practices

- Use retries for transient failures only.
- Start with low retry counts (`max: 1` or `max: 2`).
- Add backoff to avoid tight retry loops.
- Include clear failure `message` values for debugging.

## Feedback Design Pattern

1. Action returns `status: "feedback"` with a clear `message`.
2. Transition routes to a `feedback` state.
3. Human replies on the task in Notion comments.
4. Sync captures new comments and stores them in `ctx.human_feedback`.
5. Task is re-queued and runtime resumes.

## Complete Example

```ts
const analyze = async ({ ctx }) => {
  const pass = Number(ctx.attempts ?? 0) >= 1;
  if (!pass) {
    return {
      status: "feedback",
      message: "Please confirm the acceptance criteria.",
      data: { attempts: Number(ctx.attempts ?? 0) + 1 },
    };
  }
  return {
    status: "done",
    data: { approved: true },
  };
};

const decide = ({ ctx }) => (ctx.approved ? "ship" : "rework");

export default {
  id: "example-factory",
  start: "analyze",
  context: { attempts: 0 },
  states: {
    analyze: {
      type: "action",
      agent: analyze,
      on: { done: "route", feedback: "await_human", failed: "failed" },
      retries: { max: 1, backoff: { strategy: "fixed", ms: 500 } },
    },
    await_human: { type: "feedback", resume: "previous" },
    route: {
      type: "orchestrate",
      select: decide,
      on: { ship: "done", rework: "blocked" },
    },
    done: { type: "done" },
    blocked: { type: "blocked" },
    failed: { type: "failed" },
  },
};
```

## Validation Checklist

Before install:

1. `start` state exists.
2. Every transition target exists.
3. Every `action` has `on.done` and `on.failed`.
4. Loop `on.continue` equals `body`.
5. Feedback resume target is valid.
6. Runtime hooks are local (not imported runtime bindings).
7. Agent `data` fields are objects.

## Install And Smoke Test

```bash
npx notionflow factory install --path ./my-factory.ts
npx notionflow integrations notion create-task --board my-factory --factory my-factory --title "Smoke test"
npx notionflow tick --factory my-factory
```

Inspect status:

```bash
npx notionflow status --task <notion_page_id>
```

## Troubleshooting

### Install fails with runtime hook import error

Move `agent`, `select`, or `until` function declarations into the same factory file.

### Factory routes to `failed` unexpectedly

Check:

- state `on` map keys
- agent return `status`
- retry configuration and exhaustion behavior
- persisted `lastError` via `status --task`

### Feedback does not resume

Check:

- task is in `feedback`
- comment was posted after `waitingSince`
- run `npx notionflow integrations notion sync --run`

### Task keeps pausing between ticks

Increase transition budget for that run:

```bash
npx notionflow tick --factory my-factory --max-transitions-per-tick 100
```
