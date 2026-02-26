# NotionFlow

Minimal agent-agnostic orchestration CLI using Notion

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

## Core Commands

```bash
# initialize workspace
npx notionflow setup

# boards
npx notionflow board add --id main --external-id <notion_data_source_id>
npx notionflow board list
npx notionflow board remove --id main

# executors
npx notionflow executor create --id my-agent
npx notionflow executor list
npx notionflow executor describe --id my-agent

# workflows
npx notionflow workflow create --id my-workflow
npx notionflow workflow install --path ./workflows/mixed-default.yaml --parent-page <notion_page_id>
npx notionflow workflow list

# notion task ops
npx notionflow notion create-task --board my-workflow --title "Implement auth" --workflow my-workflow --status queue --ready

# notion sync (default: all Notion boards; use --board to target one)
npx notionflow notion sync
npx notionflow notion sync --board creative-writing

# notion sync + execute queued tasks (cron-friendly tick)
npx notionflow notion sync --run
npx notionflow tick

# run task locally using mixed executors
npx notionflow run --task <notion_page_id>
npx notionflow status --task <notion_page_id>
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
