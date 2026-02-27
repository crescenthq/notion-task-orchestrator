# NotionFlow

Factory-first orchestration CLI for Notion.

## What It Does

NotionFlow runs TypeScript factory state machines against Notion tasks.

- Author one factory file with inline `agent` functions.
- Install it with `notionflow factory install`.
- Create Notion tasks and run with `tick` (queue-driven) or `run` (single task).

Runtime task states:

- `queued`
- `running`
- `feedback`
- `done`
- `blocked`
- `failed`

## Prerequisites

- Node.js 20+
- A Notion integration token in `NOTION_API_TOKEN`
- A Notion parent page ID in `NOTION_WORKSPACE_PAGE_ID` (or pass `--parent-page` when creating boards)

## Quick Start (NPX)

1. Initialize local workspace.

```bash
npx notionflow setup
npx notionflow doctor
```

2. Create a factory scaffold and board.

```bash
npx notionflow factory create --id demo-factory
```

This writes a scaffold at `~/.config/notionflow/workflows/demo-factory.ts` and provisions a Notion board with ID `demo-factory`.

3. Create a task in that board.

```bash
npx notionflow integrations notion create-task --board demo-factory --factory demo-factory --title "Test run"
```

4. Run one orchestration tick (sync + execute queued task).

```bash
npx notionflow tick --factory demo-factory
```

5. Inspect local task state.

```bash
npx notionflow status --task <notion_page_id>
```

## Quick Start (Installed CLI)

1. Install and verify.

```bash
npm install -g notionflow
notionflow setup
notionflow doctor
```

2. Author a local single-file factory and install it.

```ts
const draft = async ({ ctx }) => ({
  status: "done",
  data: { ...ctx, drafted: true },
});

export default {
  id: "writing-assistant",
  start: "draft",
  context: {},
  states: {
    draft: {
      type: "action",
      agent: draft,
      on: { done: "done", failed: "failed" },
    },
    done: { type: "done" },
    failed: { type: "failed" },
  },
};
```

```bash
notionflow factory install --path ./writing-assistant.ts
```

3. Create and run a task.

```bash
notionflow integrations notion create-task --board writing-assistant --factory writing-assistant --title "Write launch note"
notionflow tick --factory writing-assistant
```

## Core Commands

```bash
# common
notionflow setup
notionflow doctor
notionflow tick [--board <id>] [--factory <id>] [--max-transitions-per-tick <n>] [--lease-mode strict|best-effort]
notionflow run --task <notion_page_id> [--max-transitions-per-tick <n>] [--lease-mode strict|best-effort]
notionflow status --task <notion_page_id>

# advanced
notionflow board list
notionflow factory create --id <factory-id>
notionflow factory install --path ./factory.ts [--skip-notion-board] [--parent-page <notion_page_id>]
notionflow factory list

# Notion integration
notionflow integrations notion provision-board --board <factory-id>
notionflow integrations notion create-task --board <board-id> --factory <factory-id> --title "..."
notionflow integrations notion sync [--board <board-id>] [--factory <factory-id>] [--run]
```

## Factory Authoring Rules

- Runtime hooks must be local to the same file: `agent`, `select`, `until`.
- Imported functions cannot be used as runtime hooks.
- `action` agent result must be:
  - `status`: `"done" | "feedback" | "failed"`
  - `data`: optional object
  - `message`: optional string
- Non-terminal states route with `on` maps.

See `tasks/factory-dsl-v0-spec.md` for the v0 DSL contract.

## Feedback, Retry, and Loop

- Feedback: return `{ status: "feedback", message }` from an `action` state and route `on.feedback` to a `feedback` state.
- Resume: feedback state defaults to resuming previous state (`resume: "previous"`).
- Retry: set `retries: { max: <n>, backoff?: { strategy: "fixed" | "exponential", ms, maxMs? } }` on action states.
- Loop: use `type: "loop"` with `body`, `maxIterations`, optional `until`, and `on: { continue, done, exhausted }`.

## Troubleshooting

### `doctor` warns `NOTION_API_TOKEN missing`

Set your token and rerun:

```bash
export NOTION_API_TOKEN=secret_...
notionflow doctor
```

### Task remains `queued` after `tick`

- Ensure the task is in Notion `State = Queue`.
- Ensure task `--factory` matches an installed factory (`notionflow factory list`).
- Run explicit sync and execution:

```bash
notionflow integrations notion sync --factory <factory-id> --run
```

### Task enters `feedback` and does not resume

- Add a new comment on the Notion task page.
- Run sync again:

```bash
notionflow integrations notion sync --run
```

NotionFlow checks comments after `waitingSince`, stores the latest reply in `human_feedback`, and re-queues the task.

### Task fails with lease/worker contention

Another worker owns the active run lease. Use one worker ID per process or switch to best-effort mode if desired:

```bash
notionflow tick --lease-mode best-effort
```

### Tick stops before terminal state

This usually means `maxTransitionsPerTick` was reached. Run another tick or raise the limit:

```bash
notionflow tick --max-transitions-per-tick 100
```

### Notion state looks stale

Re-sync from Notion and print local record:

```bash
notionflow integrations notion sync
notionflow status --task <notion_page_id>
```

### Factory install rejects runtime function imports

Keep `agent`/`select`/`until` in the same factory file. Imported helper functions can be used for non-runtime utility logic only.

## Live Verification Suite

Use the live suite in [`tasks/factory-agent-verification.md`](./tasks/factory-agent-verification.md) to validate:

- happy path
- feedback pause/resume
- retry/failure
- bounded loop
- crash/resume + replay
