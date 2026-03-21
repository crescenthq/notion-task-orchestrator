# CLI Reference

## Command Groups

Top-level commands:

- `init`
- `doctor`
- `start`
- `tick`
- `run`
- `status`
- `pipe`
- `integrations`

## Project Context Resolution

Project-scoped commands resolve `pipes.config.ts` by walking up parent
directories from the current working directory.

Supported `--config <path>` override:

- `doctor`
- `pipe create`
- `run`
- `tick`
- `start`
- `integrations notion setup`
- `integrations notion repair-task`
- `integrations notion sync`
- `integrations notion create-task`

When `--config` is provided, Pipes resolves project root from that config
file's directory.

## Common Commands

### `init`

Initialize a local Pipes project in the current directory.

```bash
pipes init
```

Creates:

- `pipes.config.ts`
- `pipes/`
- `.pipes-runtime/`

Also ensures `.pipes-runtime/` exists exactly once in `.gitignore`.

### `doctor`

Validate project resolution and Notion auth.

```bash
pipes doctor [--config <path>]
```

Prints resolved project root and config path, reports whether execution will use
the default project repo or an explicit workspace override, and validates git
workspace prerequisites without creating a run worktree.

## Workspace Config

`pipes.config.ts` supports three workspace forms:

1. Omit `workspace` to use the git repo containing the resolved project root.
2. Set `workspace` to a string for an explicit git URL.
3. Set `workspace` to an object when you need `repo`, `ref`, `cwd`, or
   `cleanup` overrides.

Examples:

```ts
export default {
  workspace: 'git@github.com:acme/service.git',
}
```

```ts
export default {
  workspace: {
    repo: 'https://github.com/acme/service.git',
    ref: 'main',
    cwd: 'packages/api',
    cleanup: 'never',
  },
}
```

### `start`

Start the interactive operator session and background tick loop.

```bash
pipes start [--config <path>] [--interval-ms <ms>] [--refresh-ms <ms>] [--limit <n>]
```

Options:

- `--config <path>`
- `--interval-ms <n>`
- `--refresh-ms <n>`
- `--limit <n>`
- `--pipe <id>`
- `--max-transitions-per-tick <n>`
- `--run-concurrency <n>`
- `--lease-ms <n>`
- `--lease-mode <strict|best-effort>`
- `--worker-id <id>`

Notes:

- `start` replaces the old loop-oriented `tick --loop` behavior.
- `start` renders the dashboard directly in the terminal with ANSI screen
  redraws.
- `start` requires an interactive TTY.
- `q` quits the session.
- `r` triggers an immediate dashboard refresh.

### `tick`

Run exactly one queue-driven orchestration tick.

```bash
pipes tick [options]
```

Options:

- `--config <path>`
- `--pipe <id>`
- `--max-transitions-per-tick <n>`
- `--run-concurrency <n>`
- `--lease-ms <n>`
- `--lease-mode <strict|best-effort>`
- `--worker-id <id>`

Notes:

- `tick` is always one-shot.
- For a long-lived worker loop and interactive status view, use `start`.

### `run`

Run one task directly by Notion page ID.

```bash
pipes run --task <notion_page_id> [options]
```

Required:

- `--task <id>`

Options:

- `--config <path>`
- `--max-transitions-per-tick <n>`
- `--lease-ms <n>`
- `--lease-mode <strict|best-effort>`
- `--worker-id <id>`

### `status`

Print local task record as JSON.

```bash
pipes status --task <notion_page_id>
```

## Pipe Commands

### `pipe create`

Create a local pipe scaffold.

```bash
pipes pipe create --id <pipe-id> [--config <path>]
```

Writes `pipes/<pipe-id>.ts` in the resolved project root.

Files under the top-level `pipes/` directory load automatically unless
`pipes.config.ts` overrides `pipes`.

### `pipe list`

List known pipes from runtime DB.

```bash
pipes pipe list
```

## Integrations: Notion

Namespace:

```bash
pipes integrations notion <subcommand>
```

### `integrations notion setup`

Set up the shared Notion board by reusing `NOTION_TASKS_DATABASE_ID`, creating a
database from project config, or adopting an existing Notion database URL.

```bash
pipes integrations notion setup [--url <notion-database-url>] [--config <path>]
```

### `integrations notion repair-task`

Clear ownership quarantine after restoring the `Pipe` property in Notion.

```bash
pipes integrations notion repair-task --task <notion_page_id> [--config <path>]
```

### `integrations notion create-task`

Create a Notion task and upsert local state.

```bash
pipes integrations notion create-task --pipe <pipe-id> --title "Task" [--status <state>] [--config <path>]
```

### `integrations notion sync`

Sync tasks from registered Notion boards.

```bash
pipes integrations notion sync [--config <path>] [--pipe <pipe-id>] [--run]
```

Extra option when `--run` is set:

- `--run-concurrency <n>`

Default queued run concurrency is `16` (clamped to max `32`).

## Runtime Paths

All runtime artifacts are project-local:

- `<project-root>/.pipes-runtime/pipes.db`
- `<project-root>/.pipes-runtime/runtime.log`
- `<project-root>/.pipes-runtime/errors.log`
- `<project-root>/.pipes-runtime/workspace-mirrors/`
- `<project-root>/.pipes-runtime/workspace-manifests/`
- `<project-root>/.pipes-runtime/workspaces/`

## Quickstart Sequence

Run the quickstart from a git repo with a valid `HEAD` commit, or configure an
explicit workspace override first.

```bash
pipes init
pipes pipe create --id demo
pipes doctor
pipes integrations notion setup
pipes integrations notion create-task --pipe demo --title "Try demo" --status queue
pipes tick --pipe demo
```
