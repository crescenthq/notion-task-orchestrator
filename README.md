# NotionFlow

Factory-first orchestration CLI using Notion.

## Quick Start

```bash
npx notionflow setup
```

`setup` initializes the local workspace at `~/.config/notionflow/`.

`doctor` verifies local workspace + Notion token auth (`NOTION_API_TOKEN`).

Optional env var:

- `NOTION_WORKSPACE_PAGE_ID` (parent page where NotionFlow creates boards)

All state lives in:

- `~/.config/notionflow/` (local workspace data)

## Commands

Command model:

- `common` commands are daily operations for running work.
- `advanced` commands are lower-frequency management operations.
- `integration` commands are provider-specific adapters (Notion today).

```bash
# common commands
npx notionflow setup
npx notionflow doctor
npx notionflow tick
npx notionflow run --task <notion_page_id>
npx notionflow status --task <notion_page_id>

# advanced: boards
npx notionflow board add --id main --external-id <notion_data_source_id>
npx notionflow board list
npx notionflow board remove --id main

# advanced: factories
npx notionflow factory create --id my-factory
npx notionflow factory install --path ./factories/my-factory.yaml --parent-page <notion_page_id>
npx notionflow factory list

# integration (Notion)
npx notionflow integrations notion create-task --board my-factory --title "Implement auth" --factory my-factory --status queue --ready
npx notionflow integrations notion sync
npx notionflow integrations notion sync --board creative-writing
npx notionflow integrations notion sync --factory my-factory
npx notionflow integrations notion sync --run
```

## Skills

NotionFlow ships these primary skills:

- `.claude/skills/setup` — onboarding, workspace init, first factory
- `.claude/skills/add-claude` — add Claude Code support
- `.claude/skills/add-codex` — add Codex support
- `.claude/skills/add-openclaw` — add OpenClaw support

## Notion Board Expectations

Provisioned Notion boards include:

- `Name` title
- `Status` select
- `Ready` checkbox

Run behavior updates Notion page state automatically:

- active step while running -> Notion `Status=<step_id>`
- local `done` -> Notion `done`
- local `blocked` -> Notion `blocked`
- local `failed` -> Notion `failed`

When you use `factory install` or `factory create`, NotionFlow will provision a Notion board with the same ID by default.
Use `--no-notion-board` to skip provisioning.
