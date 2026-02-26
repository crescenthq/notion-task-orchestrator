---
name: add-claude
description: Add Claude Code as a NotionFlow executor. Use when the user wants to use Claude Code CLI (claude) to run workflow steps.
---

# Add Claude Code Executor

## Pre-flight

```bash
npx notionflow executor list
```

If `claude` appears, ask: "Claude executor is already registered. Reinstall it?"

```bash
command -v claude && claude --version
```

If not found: "Claude Code CLI is required. Install it from https://docs.anthropic.com/en/docs/claude-code" and stop.

## Install

Write to `~/.config/notionflow/agents/claude`:

```bash
#!/usr/bin/env bash
set -euo pipefail

case "${AGENT_ACTION:-}" in
  describe)
    echo "name: claude"
    echo "description: Claude Code CLI executor"
    echo "timeout: 900"
    echo "retries: 0"
    ;;
  execute)
    INPUT=$(cat)
    PROMPT=$(echo "$INPUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(j.prompt||"")})')
    env -u CLAUDECODE claude --print --output-format text "$PROMPT"
    ;;
  *)
    echo "Unknown AGENT_ACTION: ${AGENT_ACTION:-}" >&2
    exit 1
    ;;
esac
```

```bash
chmod +x ~/.config/notionflow/agents/claude
npx notionflow executor install --path ~/.config/notionflow/agents/claude --id claude
```

## Verify

```bash
npx notionflow executor describe --id claude
```

The `env -u CLAUDECODE` ensures this executor works when NotionFlow itself runs inside Claude Code.
