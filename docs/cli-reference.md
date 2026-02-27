# CLI Reference

This page documents the NotionFlow CLI command surface, arguments, and common usage patterns.

## Installation And Invocation

Run with `npx`:

```bash
npx notionflow <command>
```

Or install globally and run directly:

```bash
npm install -g notionflow
notionflow <command>
```

## Command Groups

Top-level commands:

- `setup`
- `doctor`
- `tick`
- `run`
- `status`
- `config`
- `board`
- `factory`
- `integrations`

## Common Commands

### `setup`

Initialize local workspace and database.

```bash
notionflow setup
```

### `doctor`

Validate local setup and Notion authentication.

```bash
notionflow doctor
```

### `tick`

Run one queue-driven orchestration tick.

```bash
notionflow tick [options]
```

Options:

- `--board <id>`: restrict sync/run to one board
- `--factory <id>`: override factory id used during sync/run
- `--max-transitions-per-tick <n>`: cap transitions per task run
- `--lease-ms <n>`: lease duration in milliseconds
- `--lease-mode <strict|best-effort>`: worker contention mode
- `--worker-id <id>`: explicit worker id

Notes:

- `tick` always runs in queue mode (`runQueued: true`).
- default lease mode for `tick` is `best-effort`.

### `run`

Run one task directly by Notion page id.

```bash
notionflow run --task <notion_page_id> [options]
```

Required:

- `--task <id>`

Options:

- `--max-transitions-per-tick <n>`
- `--lease-ms <n>`
- `--lease-mode <strict|best-effort>`
- `--worker-id <id>`

Notes:

- default lease mode for `run` is `strict`.

### `status`

Print local task record as JSON.

```bash
notionflow status --task <notion_page_id>
```

## Advanced Commands

### `config set`

Set config values in local config file.

```bash
notionflow config set --key <KEY> --value <VALUE>
```

Example:

```bash
notionflow config set --key NOTION_API_TOKEN --value secret_xxx
```

### `board add`

Register an existing Notion board data source.

```bash
notionflow board add --id <board-id> --external-id <notion_data_source_id> [--name <label>]
```

### `board list`

List registered boards.

```bash
notionflow board list
```

### `board remove`

Remove a board registration and associated local data.

```bash
notionflow board remove --id <board-id>
```

### `factory create`

Create a new local TypeScript factory scaffold.

```bash
notionflow factory create --id <factory-id> [--skip-notion-board] [--parent-page <notion_page_id>]
```

### `factory install`

Install a local factory file.

```bash
notionflow factory install --path <factory-file.ts> [--skip-notion-board] [--parent-page <notion_page_id>]
```

### `factory list`

List installed factories.

```bash
notionflow factory list
```

## Integration Commands

### Namespace

Integration commands are namespaced under:

```bash
notionflow integrations notion <subcommand>
```

### `integrations notion provision-board`

Create a Notion board and register it locally.

```bash
notionflow integrations notion provision-board --board <factory-id> [--title <name>] [--parent-page <notion_page_id>]
```

### `integrations notion create-task`

Create a task page in Notion and upsert local task state.

```bash
notionflow integrations notion create-task --board <board-id> --title "Task title" [--factory <factory-id>] [--status <state>]
```

Defaults:

- `--status` defaults to `queue`
- `--factory` defaults to `mixed-default` when omitted

### `integrations notion sync`

Sync tasks from Notion into local DB.

```bash
notionflow integrations notion sync [--board <board-id>] [--factory <factory-id>] [--run]
```

Options:

- `--board`: sync one board
- `--factory`: override factory id for synced tasks
- `--run`: immediately run queued tasks after sync

## Environment Variables And Local Config

NotionFlow resolves credentials in this order:

1. environment variables
2. local config file

Supported keys:

- `NOTION_API_TOKEN`
- `NOTION_WORKSPACE_PAGE_ID`

Local paths:

- config root: `~/.config/notionflow`
- config file: `~/.config/notionflow/config.json`
- database: `~/.config/notionflow/notionflow.db`
- workflows directory: `~/.config/notionflow/workflows`

## Task Lifecycle States

Operational task states used by runtime and sync:

- `queued`
- `running`
- `feedback`
- `done`
- `blocked`
- `failed`

## Common Operational Workflows

### First-time setup

```bash
notionflow setup
notionflow config set --key NOTION_API_TOKEN --value <token>
notionflow doctor
```

### Create and run a factory

```bash
notionflow factory create --id demo
notionflow integrations notion create-task --board demo --factory demo --title "Test"
notionflow tick
```

### Resume feedback tasks

```bash
notionflow integrations notion sync --run
```

## Troubleshooting

### `NOTION_API_TOKEN is required`

Set token via environment variable or:

```bash
notionflow config set --key NOTION_API_TOKEN --value <token>
```

### `No Notion boards registered`

Provision or register a board:

```bash
notionflow integrations notion provision-board --board <id>
# or
notionflow board add --id <id> --external-id <notion_data_source_id>
```

### Worker lease contention errors

If multiple workers run simultaneously:

- use unique `--worker-id`
- use `--lease-mode best-effort` for non-blocking queue workers

### Task appears stale in local state

Force a sync and inspect status:

```bash
notionflow integrations notion sync
notionflow status --task <notion_page_id>
```
