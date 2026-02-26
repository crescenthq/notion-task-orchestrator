---
name: add-codex
description: Add Codex as a NotionFlow executor. Use when the user wants to use OpenAI Codex CLI to run workflow steps.
---

# Add Codex Executor

## Pre-flight

```bash
npx notionflow executor list
```

If `codex` appears, ask: "Codex executor is already registered. Reinstall it?"

```bash
command -v codex && codex --version
```

If not found: "Codex CLI is required. Install it from https://github.com/openai/codex" and stop.

## Install

Write to `~/.config/notionflow/agents/codex`:

```bash
#!/usr/bin/env bash
set -euo pipefail

case "${AGENT_ACTION:-}" in
  describe)
    echo "name: codex"
    echo "description: Codex CLI executor"
    echo "timeout: 900"
    echo "retries: 0"
    ;;
  execute)
    INPUT=$(cat)
    PROMPT=$(echo "$INPUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(j.prompt||"")})')
    codex exec --full-auto "$PROMPT"
    ;;
  *)
    echo "Unknown AGENT_ACTION: ${AGENT_ACTION:-}" >&2
    exit 1
    ;;
esac
```

```bash
chmod +x ~/.config/notionflow/agents/codex
npx notionflow executor install --path ~/.config/notionflow/agents/codex --id codex
```

## Verify

```bash
npx notionflow executor describe --id codex
```
