# Factory DSL v0 Spec

This is the runtime contract for TypeScript factory modules loaded by NotionFlow.

## Module Shape

A factory file must `export default` an object with:

- `id: string`
- `start: string`
- `context?: Record<string, unknown>`
- `states: Record<string, State>`
- `guards?: Record<string, (input) => boolean>`

The `start` state ID must exist in `states`.

## State Types

### Action State

```ts
{
  type: "action";
  agent: (input) => Promise<{ status: "done" | "feedback" | "failed"; data?: object; message?: string }> | { ... };
  on: Record<string, string>; // must include done + failed, feedback if emitted
  retries?: {
    max: number; // or legacy maxRetries, exactly one
    backoff?: {
      strategy?: "fixed" | "exponential";
      ms: number;
      maxMs?: number;
    };
  };
}
```

Runtime validates action result shape before routing transitions.

### Orchestrate State

```ts
{
  type: "orchestrate";
  select?: (input) => string;
  agent?: (input) => Promise<{ status: string; data?: object; message?: string }> | { ... };
  on: Record<string, string>;
}
```

At least one of `select` or `agent` is required. The emitted event must be a key in `on`.

### Loop State

```ts
{
  type: "loop";
  body: string;
  maxIterations: number;
  until?: string | ((input) => boolean);
  on: {
    continue: string;
    done: string;
    exhausted: string;
  };
}
```

`on.continue` must target `body`.

### Feedback State

```ts
{
  type: "feedback";
  resume?: "previous" | string;
}
```

`resume` defaults to previous state when omitted.

### Terminal States

```ts
{ type: "done" }
{ type: "failed" }
{ type: "blocked" }
```

## Transition Contract

All non-terminal states transition through `on` event maps only.

- No `then`/`else` branching fields.
- No implicit transition targets.
- All `on` targets must reference existing state IDs.

## Runtime Hook Locality Rule

Runtime hooks must be inline or same-file symbols:

- `action.agent`
- `orchestrate.agent`
- `orchestrate.select`
- `loop.until` (function variant)

Imported identifiers cannot be used in these runtime slots.

## Runtime Input (Agent/Select/Until)

Runtime passes an object that includes:

- `ctx`: current mutable context object
- `taskId`: local task UUID
- `runId`: run UUID
- `tickId`: tick UUID
- `stateId`: current state ID
- `attempt`: action attempt number (for retry-enabled action states)

Common context keys populated by runtime include:

- `task_id` (Notion page ID)
- `task_title`
- `task_prompt`
- `task_context`
- `human_feedback` (when feedback comment is consumed)

## Runtime Status Model

Task/run lifecycle states used by execution:

- `queued`
- `running`
- `feedback`
- `done`
- `blocked`
- `failed`

## Tick Safety

Runtime enforces per-tick transition limits and run-level lease semantics.

- `maxTransitionsPerTick` defaults to 25.
- Tick exits cleanly when budget is reached and resumes next tick.
- Run lease options:
  - `strict`: reject when another worker owns an unexpired lease
  - `best-effort`: skip conflicted runs

## Transition Event Journal

Each state transition persists a structured event containing:

- `runId`
- `tickId`
- `fromStateId`
- `toStateId`
- `event`
- `reason`
- `attempt`
- `loopIteration`
- `createdAt`

These events are used for replay/debug validation.
