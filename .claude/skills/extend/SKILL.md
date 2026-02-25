# Extend NotionFlow

How to add agents, workflows, and boards to a NotionFlow installation.

## Agent Protocol

Agents are executable files in `agents/` (configurable via `AGENTS_DIR`). Each agent responds to the `AGENT_ACTION` environment variable.

### Describe

Returns agent metadata as `KEY: value` lines on stdout.

```bash
AGENT_ACTION=describe ./agents/myagent
```

Expected output:
```
name: myagent
description: What this agent does
timeout: 600
retries: 1
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| name | string | filename | Agent display name |
| description | string | "" | Human-readable description |
| timeout | int | 600 | Execution timeout in seconds |
| retries | int | 1 | Retry count on failure |

### Execute

Receives JSON on stdin, returns plain text on stdout. Exit non-zero on failure.

```bash
echo '{"prompt":"...","session_id":"...","timeout":600,"workdir":"."}' | AGENT_ACTION=execute ./agents/myagent
```

**Stdin JSON:**
```json
{
  "prompt": "The task prompt/instructions",
  "session_id": "Unique session identifier",
  "timeout": 600,
  "workdir": "/path/to/working/directory"
}
```

**Stdout:** Plain text output (agent's response/result).

**Exit code:** 0 = success, non-zero = failure (engine retries up to configured retries).

### Status Directives

Agents can emit a `STATUS:` directive in their output to override the workflow transition:

```
STATUS: done
STATUS: blocked
STATUS: retry
STATUS: failed
```

## Creating a New Agent

1. Create an executable file in `agents/`:

```bash
#!/usr/bin/env bash
set -euo pipefail

case "${AGENT_ACTION:-}" in
  describe)
    echo "name: myagent"
    echo "description: My custom agent"
    echo "timeout: 300"
    echo "retries: 1"
    ;;
  execute)
    INPUT=$(cat)
    PROMPT=$(echo "$INPUT" | jq -r '.prompt')
    SESSION_ID=$(echo "$INPUT" | jq -r '.session_id')
    TIMEOUT=$(echo "$INPUT" | jq -r '.timeout // 300')
    WORKDIR=$(echo "$INPUT" | jq -r '.workdir // "."')

    cd "$WORKDIR"
    # Your agent logic here
    echo "Agent response text"
    ;;
  *)
    echo "Unknown AGENT_ACTION: ${AGENT_ACTION:-<unset>}" >&2
    exit 1
    ;;
esac
```

2. `chmod +x agents/myagent`
3. Verify: `AGENT_ACTION=describe ./agents/myagent`
4. Test: `echo '{"prompt":"hello","session_id":"test","timeout":10,"workdir":"."}' | AGENT_ACTION=execute ./agents/myagent`

Agents can be any language — bash, python, node, go, rust — as long as they're executable and follow the describe/execute protocol.

## Workflow YAML Schema

Workflows define multi-step execution plans. Located in `workflows/` (configurable via `WORKFLOWS_DIR`).

```yaml
id: my-workflow
name: My Workflow
description: Optional
steps:
  - id: step-one
    agent: openclaw
    timeout: 420
    retries: 1
    prompt: |
      Do something for {{task_name}}.
      Context: {{task_context}}
    on_success: next
    on_fail: blocked

  - id: step-two
    agent: openclaw
    timeout: 900
    retries: 2
    prompt: |
      Continue with {{task_name}}.
      Previous output: {{step_step-one_output}}
    on_success: done
    on_fail: retry
```

### Template Variables

| Variable | Description |
|----------|-------------|
| `{{task_name}}` | Notion task page title |
| `{{task_context}}` | Notion page body content |
| `{{workdir}}` | Working directory path |
| `{{step_<id>_output}}` | Output from a previous step |
| `{{<step_id>_<key>}}` | Parsed key-value from a previous step |

### Step Transitions

| Transition | Behavior |
|------------|----------|
| `next` | Proceed to next step |
| `done` | Mark task done, stop workflow |
| `blocked` | Mark task blocked, save state for resume |
| `retry` | Treated as blocked (manual or comment-driven resume) |
| `failed` | Permanent failure, mark blocked |

## CLI Reference

```bash
# Boards
notionflow board list [--json]
notionflow board add --id <id> --data-source-id <id> [--name <n>] [--default-workflow <id>]
notionflow board remove --id <id>

# Workflows
notionflow workflow list
notionflow workflow validate <path>

# Agents
notionflow agent list
notionflow agent describe <name>

# Runs
notionflow run <board-id> [--task <page-id>] [--workflow <id>] [--dry-run]
notionflow status <run-id>
notionflow resume <run-id>
notionflow logs [--run <run-id>]
```
