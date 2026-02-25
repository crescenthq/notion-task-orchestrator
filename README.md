# NotionFlow

Agent-agnostic task orchestrator for Notion boards.

## Install

```bash
git clone <repo-url>
cd notion-task-orchestrator
bash install.sh
```

This installs NotionFlow to `~/.config/notionflow/` and the setup skill
to `~/.openclaw/skills/`, `~/.claude/skills/`, and `~/.agents/skills/`.

Then use `/notionflow-setup` to configure your Notion API key and create your first board.

## What it does

Picks tasks from Notion databases, runs them through multi-step YAML workflows
using pluggable agent executables, and writes results back to the page.
Each workflow gets its own Notion database (board).

## Skills

- `/notionflow-setup` — Guided setup (API key, workspace, boards)
- `.claude/skills/extend/SKILL.md` — Adding agents and workflows

## CLI

```bash
# Init & Config
notionflow init
notionflow config set <key> <value>
notionflow config get <key>

# Boards
notionflow board list [--json]
notionflow board add --id <id> --data-source-id <id> [--name <n>] [--default-workflow <id>]
notionflow board remove --id <id>

# Workflows
notionflow workflow list
notionflow workflow validate <path>
notionflow workflow install <path>

# Agents
notionflow agent list
notionflow agent describe <name>
notionflow agent install <path>

# Runs
notionflow run <board-id> [--task <page-id>] [--workflow <id>] [--dry-run]
notionflow status <run-id>
notionflow resume <run-id>
notionflow logs [--run <run-id>]
```

## Agent Protocol

Agents are executables in `~/.config/notionflow/agents/` that respond to `AGENT_ACTION=describe` and `AGENT_ACTION=execute`. See `.claude/skills/extend/SKILL.md` for the full protocol spec and how to create agents and workflows.

## Config Keys

| Key | Description |
|-----|-------------|
| `notion-api-key` | Notion integration secret |
| `workspace-page-id` | Parent page for auto-created databases |
| `default-agent` | Agent for comment forwarding (default: openclaw) |
| `default-workflow` | Default workflow ID (default: default-task) |
