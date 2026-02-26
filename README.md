# NotionFlow

Minimal agent-agnostic orchestration CLI using Notion

## Quick Start

```bash
bun install
bun run src/cli.ts setup
bun run src/cli.ts doctor
bun run src/cli.ts tick
```

`setup` bootstraps local workspace, installs bundled executors, installs the default workflow, and provisions a Notion board when credentials are available.

`doctor` verifies local workspace + Notion token auth (`NOTION_API_TOKEN`).

Optional env var:

- `NOTION_WORKSPACE_PAGE_ID` (parent page where NotionFlow creates boards)

All commands use:

- `~/.config/notionflow/agents/`
- `~/.config/notionflow/workflows/`

## Core Commands

```bash
# one-command bootstrap
bun run src/cli.ts setup
bun run src/cli.ts setup --no-notion-board

# boards
bun run src/cli.ts board add --id main --external-id <notion_data_source_id>
bun run src/cli.ts board list
bun run src/cli.ts board remove --id main

# executors
bun run src/cli.ts executor install --id claude --path ./agents/claude
bun run src/cli.ts executor install --id codex --path ./agents/codex
bun run src/cli.ts executor install --id shell --path ./agents/shell
bun run src/cli.ts executor create --id my-custom-agent
bun run src/cli.ts executor list
bun run src/cli.ts executor describe --id claude

# workflows
bun run src/cli.ts workflow install --path ./workflows/mixed-default.yaml --parent-page <notion_page_id>
bun run src/cli.ts workflow create --id my-workflow
bun run src/cli.ts workflow list

# notion task ops
bun run src/cli.ts notion create-task --board my-workflow --title "Implement auth" --workflow my-workflow --status queue --ready

# notion sync (default: all Notion boards; use --board to target one)
bun run src/cli.ts notion sync
bun run src/cli.ts notion sync --board creative-writing

# notion sync + execute queued tasks (cron-friendly tick)
bun run src/cli.ts notion sync --run
bun run src/cli.ts tick

# run task locally using mixed executors
bun run src/cli.ts run --task <notion_page_id>
bun run src/cli.ts status --task <notion_page_id>
```

## Setup Skills

NotionFlow keeps the core runtime small and uses setup skills for environment-specific automation:

- `.claude/skills/setup` for baseline onboarding.
- `.claude/skills/setup-notionflow-openclaw` for OpenClaw executor setup.
- `.claude/skills/setup-mac` for macOS automation including cron installation for `tick`.

## Notion Board Expectations

Provisioned Notion boards include:

- `Name` title
- `Status` select
- `Ready` checkbox
- `Workflow` rich text

Run behavior updates Notion page state automatically:

- active step while running -> Notion `Status=<step_id>`
- local `done` -> Notion `done`
- local `blocked` -> Notion `blocked`
- local `failed` -> Notion `failed`

When you use `workflow install` or `workflow create`, NotionFlow will provision a Notion board with the same ID by default.
Use `--no-notion-board` to skip provisioning.

## Workflow Registry Direction

NotionFlow should feel Notion-first for users. A good next step is a single Notion "Workflow Registry" page where each child page stores one workflow YAML (or one database row per workflow), and `workflow pull` / `workflow push` keep local copies synced.

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

Executors in this repo:

- `agents/claude`
- `agents/codex`
- `agents/shell`
