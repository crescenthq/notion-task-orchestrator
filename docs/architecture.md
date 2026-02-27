# Architecture

NotionFlow creates an assembly line for running task factories in Notion.

This page explains how the system is designed so operators and factory authors can reason about runtime behavior, durability, and integration boundaries.

## System Overview

At runtime, NotionFlow connects four layers:

1. CLI command layer
2. Factory runtime layer
3. Local persistence layer (SQLite)
4. Notion integration layer

A typical tick follows this flow:

```text
Notion board
  -> sync tasks into local DB
  -> select queued tasks
  -> run factory state machine
  -> persist run + transitions + context
  -> update Notion state/logs/comments
```

## Core Concepts

### Factory

A factory is a TypeScript state machine exported as the default object in a single file.

A factory defines:

- `id`
- `start` state
- optional initial `context`
- `states` (action/orchestrate/loop/feedback/terminal)
- optional `guards`

### Task

A task is a Notion page mirrored locally in `tasks`.

Each local task stores:

- lifecycle state (`queued`, `running`, `feedback`, `done`, `blocked`, `failed`)
- current step pointer (`currentStepId`)
- persisted context (`stepVarsJson`)
- failure details (`lastError`)

### Run

A run is one execution session for a task.

Runs track:

- current runtime status
- run-level context record
- lease ownership for worker coordination
- start/end timestamps

### Transition Event

Every state transition is recorded as an immutable event with:

- `fromStateId` / `toStateId`
- event key (`done`, `feedback`, custom route keys, etc.)
- reason code (for example `action.done`, `loop.exhausted`)
- retry attempt and loop iteration metadata

## Runtime Architecture

The runtime entrypoint is task execution by external task id.

Execution stages:

1. Resolve task, board, and factory registration from SQLite.
2. Load factory file from local workflows directory.
3. Build runtime context from factory defaults, task metadata, and persisted state.
4. Acquire or resume run with lease protection.
5. Execute transitions until terminal state, feedback pause, or per-tick budget limit.
6. Persist outputs and sync state/log changes to Notion.

### State Dispatch Model

- `action`: executes async agent logic and routes on `done`/`feedback`/`failed`.
- `orchestrate`: routes by `select` or agent-produced event key.
- `loop`: controls bounded iteration with `continue`/`done`/`exhausted`.
- `feedback`: pauses execution and waits for human reply.
- `done|failed|blocked`: terminal states.

### Context Model

Runtime context is a shallow-merged object carried across transitions.

Context sources:

1. factory `context`
2. runtime task envelope (`task_id`, `task_title`, `task_prompt`, `task_context`)
3. persisted task context from prior runs
4. each state result `data`

### Retry and Backoff

Action states can define retries:

- max retries (`retries.max`)
- optional fixed or exponential backoff
- optional max backoff cap (`maxMs`)

Failed attempts are persisted as transition events so retry behavior is fully traceable.

### Feedback Pause and Resume

When a state routes to `feedback`:

- task becomes `feedback`
- `waitingSince` is recorded
- runtime exits and releases lease

During sync, NotionFlow checks comments newer than `waitingSince`.
If a new reply exists, it is stored as `ctx.human_feedback`, the task is re-queued, and execution can continue on next tick/run.

### Tick Budget and Continuation

Per execution call, runtime enforces `maxTransitionsPerTick`.

If budget is exhausted before terminal state:

- task remains `running`
- state pointer and context are persisted
- lease is released
- next tick resumes from saved state

### Lease Safety

Run leases prevent concurrent workers from processing the same active run.

Modes:

- `strict`: fail when another worker holds lease
- `best-effort`: skip task when lease is held

## Persistence Architecture

NotionFlow stores operational state in local SQLite under:

- `~/.config/notionflow/notionflow.db`

Key tables:

- `boards`: board registrations
- `workflows`: installed factory definitions
- `tasks`: mirrored task state + resume context
- `runs`: execution sessions + lease fields
- `transition_events`: transition audit trail
- `inbox_events`, `board_cursors`: sync support

Schema bootstrapping runs automatically on startup and applies additive upgrades for required columns.

## Notion Integration Architecture

Notion integration is implemented as an adapter around Notion APIs.

### Board Provisioning

`integrations notion provision-board` creates a data source and ensures properties exist:

- `Name`
- `State`
- `Status`

### Task Sync

Sync pulls pages from each registered Notion board and upserts local tasks.

Important behavior:

- local `feedback` and `running` states are preserved during upsert to avoid stale remote overwrite
- queued tasks can be run immediately when sync is invoked with run mode

### State Mirroring and Logs

Runtime updates Notion task state and appends operational callout logs for key events (start, retry, feedback wait, completion, failure).

Feedback prompts can also be posted as Notion comments.

## Command Layer Architecture

The top-level CLI is grouped by concern:

- common: `setup`, `doctor`, `tick`, `run`, `status`
- advanced: `config`, `board`, `factory`
- integration: `integrations notion ...`

`tick` is the queue-driven operational path.
`run` is the single-task execution path.

## Reliability and Observability

Reliability controls:

- schema validation at factory install/load
- runtime validation of agent return shape
- retry/backoff and loop bounds
- lease ownership and heartbeat checks
- transition cap guardrail

Observability surfaces:

- local task status (`status` command)
- persisted run and transition records
- Notion logs/comments on task pages

## Testing Model

The project validates behavior through:

- unit tests for schema, loader, runtime, and transition replay
- integration-style tests for CLI/service behavior
- live end-to-end verification scenarios for:
  - happy path
  - feedback pause/resume
  - retry exhaustion
  - bounded loops
  - resume across multiple ticks

## Where To Go Next

- See [Factory Authoring Guide](./factory-authoring.md) to build production-ready factories.
- See [CLI Reference](./cli-reference.md) for command options and operational workflows.
