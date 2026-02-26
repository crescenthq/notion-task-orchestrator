# NotionFlow

Minimal agent-agnostic orchestration CLI using Notion.

## Quick Start

```bash
npx notionflow setup
```

`setup` initializes the local workspace at `~/.config/notionflow/`.

`doctor` verifies local workspace + Notion token auth (`NOTION_API_TOKEN`).

Optional env var:

- `NOTION_WORKSPACE_PAGE_ID` (parent page where NotionFlow creates boards)

All state lives in:

- `~/.config/notionflow/agents/`
- `~/.config/notionflow/workflows/`

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

# advanced: executors
npx notionflow executor create --id my-agent
npx notionflow executor list
npx notionflow executor describe --id my-agent

# advanced: workflows
npx notionflow workflow create --id my-workflow
npx notionflow workflow install --path ./workflows/mixed-default.yaml --parent-page <notion_page_id>
npx notionflow workflow list

# integration (Notion)
npx notionflow integrations notion create-task --board my-workflow --title "Implement auth" --workflow my-workflow --status queue --ready
npx notionflow integrations notion sync
npx notionflow integrations notion sync --board creative-writing
npx notionflow integrations notion sync --run
```

## Skills

NotionFlow ships these primary skills:

- `.claude/skills/setup` — onboarding, workspace init, first workflow
- `.claude/skills/add-claude` — add Claude Code as an executor
- `.claude/skills/add-codex` — add Codex as an executor
- `.claude/skills/add-openclaw` — add OpenClaw as an executor

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

When you use `workflow install` or `workflow create`, NotionFlow will provision a Notion board with the same ID by default.
Use `--no-notion-board` to skip provisioning.

## Agent Executor Contract

Every executor is an executable that supports:

- `AGENT_ACTION=describe`
- `AGENT_ACTION=execute`

`execute` receives JSON payload on stdin:

```json
{
  "prompt": "...",
  "session_id": "task-...",
  "workdir": "/path",
  "timeout": 600,
  "step_id": "plan",
  "task_id": "<external task id>"
}
```

Create executors with `executor create --id <name>` or use add-on skills for pre-configured agents.
