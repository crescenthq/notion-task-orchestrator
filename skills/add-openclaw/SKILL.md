---
name: add-openclaw
description: Add an OpenClaw agent as a NotionFlow executor. Use when the user wants to use OpenClaw to run workflow steps. Supports targeting specific OpenClaw agents by ID.
---

# Add OpenClaw Executor

OpenClaw manages its own agents (`openclaw agents add <id>`), each with its own workspace, identity files, and config. The executor just calls `openclaw agent` and lets OpenClaw handle the rest.

## Pre-flight

```bash
npx notionflow executor list
```

If an openclaw executor already appears, ask: "OpenClaw executor is already registered. Reinstall it?"

```bash
command -v openclaw
```

If not found: "OpenClaw not found on PATH. Install it first." and stop.

Check which OpenClaw agents exist:

```bash
openclaw agents list
```

## Install

Use AskUserQuestion: "Which OpenClaw agent should this executor target? (e.g. 'main', a specific agent ID, or 'any' to let the prompt decide)"

The executor ID defaults to `openclaw` for the main agent, or `openclaw_<agentId>` for a specific agent.

Write the executor to `~/.config/notionflow/agents/<executor-id>`:

```bash
#!/usr/bin/env bash
set -euo pipefail

case "${AGENT_ACTION:-}" in
  describe)
    echo "name: <executor-id>"
    echo "description: OpenClaw (<agentId>) executor"
    echo "timeout: 900"
    echo "retries: 0"
    ;;
  execute)
    INPUT=$(cat)
    PROMPT=$(echo "$INPUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(j.prompt||"")})')
    openclaw agent --agent <agentId> --message "$PROMPT"
    ;;
  *)
    echo "Unknown AGENT_ACTION: ${AGENT_ACTION:-}" >&2
    exit 1
    ;;
esac
```

Replace `<agentId>` with the chosen agent ID. For the main agent, omit `--agent <agentId>`.

```bash
chmod +x ~/.config/notionflow/agents/<executor-id>
npx notionflow executor install --path ~/.config/notionflow/agents/<executor-id> --id <executor-id>
```

## Verify

```bash
npx notionflow executor describe --id <executor-id>
```

## Multiple OpenClaw Agents

To register multiple OpenClaw agents as separate executors (e.g. for a factory), repeat the install for each agent ID. Or use the **add-factory** skill which handles multi-executor workflows.

OpenClaw's own agent management (`openclaw agents add`, identity files, workspace config) is the right place to configure agent behavior — not the executor script.
