# CLI Reference

## Command Groups

Top-level commands:

- `init`
- `doctor`
- `tick`
- `run`
- `status`
- `factory`
- `integrations`

## Project Context Resolution

Project-scoped commands resolve `notionflow.config.ts` by walking up parent
directories from the current working directory.

Supported `--config <path>` override:

- `doctor`
- `factory create`
- `run`
- `tick`
- `integrations notion sync`
- `integrations notion sync-factories`
- `integrations notion create-task`

When `--config` is provided, NotionFlow resolves project root from that config
file's directory.

## Common Commands

### `init`

Initialize a local NotionFlow project in the current directory.

```bash
notionflow init
```

Creates:

- `notionflow.config.ts`
- `factories/`
- `.notionflow/`

Also ensures `.notionflow/` exists exactly once in `.gitignore`.

### `doctor`

Validate project resolution and Notion auth.

```bash
notionflow doctor [--config <path>]
```

Prints resolved project root and config path.

### `tick`

Run queue-driven orchestration.

```bash
notionflow tick [options]
```

Options:

- `--config <path>`
- `--board <id>`
- `--factory <id>`
- `--loop`
- `--interval-ms <n>`
- `--max-transitions-per-tick <n>`
- `--lease-ms <n>`
- `--lease-mode <strict|best-effort>`
- `--worker-id <id>`

Loop behavior defaults:

- one-shot unless `--loop` is set
- 2000ms successful cycle delay
- retryable Notion errors: `429` and transient `5xx`
- exponential backoff with jitter and cap

### `run`

Run one task directly by Notion page ID.

```bash
notionflow run --task <notion_page_id> [options]
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
notionflow status --task <notion_page_id>
```

## Factory Commands

### `factory create`

Create a local factory scaffold.

```bash
notionflow factory create --id <factory-id> [--config <path>] [--skip-notion-board]
```

Writes `factories/<factory-id>.ts` in the resolved project root.

### `factory list`

List known factories from runtime DB.

```bash
notionflow factory list
```

## Integrations: Notion

Namespace:

```bash
notionflow integrations notion <subcommand>
```

### `integrations notion provision-board`

Create and register a Notion board.

```bash
notionflow integrations notion provision-board --board <board-id> [--title <name>] [--parent-page <notion_page_id>] [--config <path>]
```

### `integrations notion create-task`

Create a Notion task and upsert local state.

```bash
notionflow integrations notion create-task [--board <board-id> | --factory <factory-id>] --title "Task" [--status <state>] [--config <path>]
```

### `integrations notion sync`

Sync tasks from registered Notion boards.

```bash
notionflow integrations notion sync [--config <path>] [--board <board-id>] [--factory <factory-id>] [--run]
```

### `integrations notion sync-factories`

Provision (or refresh) Notion boards for declared factories.

```bash
notionflow integrations notion sync-factories [--config <path>] [--factory <factory-id>] [--parent-page <notion_page_id>]
```

## Runtime Paths

All runtime artifacts are project-local:

- `<project-root>/.notionflow/notionflow.db`
- `<project-root>/.notionflow/runtime.log`
- `<project-root>/.notionflow/errors.log`

## Quickstart Sequence

```bash
notionflow init
notionflow factory create --id demo --skip-notion-board
notionflow doctor
notionflow integrations notion sync-factories --factory demo
notionflow tick --factory demo
```
