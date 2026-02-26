---
name: add-factory
description: Create an agent factory — a workflow powered by multiple specialized executors. Agent-agnostic. Works with Claude, Codex, OpenClaw, shell, or any command. Use when the user wants to create a factory, build a multi-agent pipeline, set up specialized agents, or chain multiple executors into a workflow.
---

# Create Agent Factory

A factory is a workflow + a cohort of specialized executors. Each executor wraps a command — any command. The workflow chains their outputs via `{{variables}}`.

**Principle:** The executor is a thin bridge. It translates the AGENT_ACTION protocol to whatever CLI the user wants. Don't reimplement what the agent runtime already does.

## Pre-flight

```bash
npx notionflow executor list
npx notionflow workflow list
```

## Phase 1 — Design the Factory

Use AskUserQuestion: "What kind of factory do you want to create?"

Offer templates as starting points:

- **Code factory** — planner → developer → reviewer → PR
- **Content factory** — researcher → writer → editor
- **Bug fix factory** — triager → investigator → fixer → verifier
- **Custom** — describe your own roles and pipeline

Use AskUserQuestion: "What should this factory be called? (e.g. code-factory, content-pipeline, bug-squad)"

The factory name namespaces everything: executor IDs become `<factory>_<role>`, the workflow ID is `<factory>`.

## Phase 2 — Define Roles and Commands

For each role, the user picks the command that runs it. Use AskUserQuestion for each role: "What command should run the <role> role?"

Examples the user might give:

- `openclaw agent --agent planner` — uses an existing OpenClaw agent (user configures identity via `openclaw agents add`)
- `claude --print --output-format text` — Claude Code CLI
- `codex exec --full-auto` — Codex CLI
- `my-script.sh` — any executable
- `shell` — the prompt IS the script (eval it directly)

If the user says "openclaw", ask which OpenClaw agent ID to target (or whether they need to create one first via `openclaw agents add <id>`).

If the user says "claude" or "codex", use the standard invocation. Don't add flags the user didn't ask for.

## Phase 3 — Create Executors

For each role, create an executor at `~/.config/notionflow/agents/<factory>_<role>`.

### Executor anatomy

The executor is a bash script that responds to two actions via the `AGENT_ACTION` environment variable:

- `describe` — print metadata (name, description, timeout, retries) to stdout
- `execute` — read a JSON payload from stdin, run the agent, write output to stdout

The JSON payload has these fields:

- `prompt` — the rendered step prompt (all `{{variables}}` already substituted)
- `workdir` — the NotionFlow working directory
- `task_id` — Notion page ID of the task
- `step_id` — current step ID
- `session_id` — stable session ID for the task

### Clean executor template

```bash
#!/usr/bin/env bash
set -euo pipefail

case "${AGENT_ACTION:-}" in
  describe)
    echo "name: <factory>_<role>"
    echo "description: <one-line role description>"
    echo "timeout: <seconds>"
    echo "retries: 0"
    ;;
  execute)
    # Read the JSON payload from stdin
    INPUT=$(cat)
    # Helper: extract a named field from the payload JSON
    nf_field() { printf '%s' "$INPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(d)['$1']??''))"; }

    PROMPT=$(nf_field prompt)   # The rendered step prompt
    WORKDIR=$(nf_field workdir) # NotionFlow working directory

    # Run the agent — stdout is what NotionFlow reads for STATUS and KEY: value lines
    <command> -- "$PROMPT"
    ;;
  *)
    echo "Unknown AGENT_ACTION: ${AGENT_ACTION:-}" >&2
    exit 1
    ;;
esac
```

The `nf_field` helper is the readable way to extract JSON fields. Define it once, call it per field. It pipes `$INPUT` through a small Node.js snippet (Node is already required by NotionFlow).

### Command reference

Replace `<command>` with the agent invocation. Use `--` before `"$PROMPT"` when the command accepts flags — this tells the argument parser that everything after `--` is positional, preventing the prompt text from being misread as a flag.

| Agent               | Command line                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------ |
| Claude (simple)     | `env -u CLAUDECODE claude --print --output-format text -- "$PROMPT"`                       |
| Claude (extra dir)  | `env -u CLAUDECODE claude --print --output-format text --add-dir "$WORKTREE" -- "$PROMPT"` |
| Codex               | `codex exec --full-auto -- "$PROMPT"`                                                      |
| OpenClaw agent      | `openclaw agent --agent <id> --message "$PROMPT"`                                          |
| Shell (eval prompt) | `eval "$PROMPT"`                                                                           |
| Custom script       | `/path/to/script "$PROMPT"`                                                                |

`env -u CLAUDECODE` removes the `CLAUDECODE` env var so the Claude executor works when NotionFlow itself runs inside Claude Code.

**`--add-dir` gotcha:** `--add-dir` accepts multiple paths. If you write `claude --add-dir "$DIR" "$PROMPT"`, Claude's parser treats `$PROMPT` as a second directory, leaving no prompt — you'll get "Input must be provided" errors. Always use `--` before `"$PROMPT"`.

### Register each executor

```bash
chmod +x ~/.config/notionflow/agents/<factory>_<role>
npx notionflow executor install --path ~/.config/notionflow/agents/<factory>_<role> --id <factory>_<role>
```

## Phase 4 — Scaffold Workflow

```bash
npx notionflow workflow create --id <factory> --skip-notion-board
```

Overwrite `~/.config/notionflow/workflows/<factory>.yaml` with steps chaining the executors.

Every step needs:

- `id` — descriptive kebab-case name; appears as the Notion Status while the step runs (e.g. `research`, `write-draft`, `security-scan`). Never use generic names like `step1`.
- `icon` — emoji shown as prefix in the Notion Status (e.g. `🔍`, `✍️`, `🧪`). Always set one per step.
- `agent` — executor ID (`<factory>_<role>`)
- `prompt` — what the agent should do, using `{{variables}}` for chaining
- `timeout`, `retries`, `on_success`, `on_fail`

### Step icons

Pick an emoji that communicates the step's role at a glance:

| Role               | Icon |
| ------------------ | ---- |
| Research / gather  | 🔍   |
| Plan / outline     | 📋   |
| Analyse / diagnose | 🔬   |
| Write / draft      | ✍️   |
| Code / implement   | 💻   |
| Review / edit      | ✏️   |
| Test / verify      | 🧪   |
| Security scan      | 🔒   |
| Performance        | ⚡   |
| Summarise / report | 📝   |
| Notify / publish   | 🚀   |
| Fetch / shell      | 🛠️   |

### Variable chaining

Step outputs are parsed line by line for `KEY: value` pairs. A step with `id: plan` that outputs `PLAN: do x then y` makes `{{plan_plan}}` available to all later steps.

Rules:

- Keys are case-insensitive and lowercased (so `FILES_TO_CHANGE: foo` → `{{plan_files_to_change}}`)
- Keys must start with a letter and contain only letters, digits, underscores
- Multi-word values are captured up to the end of the line only (not multi-line)
- `STATUS:` is consumed by NotionFlow and not stored as a variable

Every step's prompt must instruct the agent to reply with `STATUS: done` plus the `KEY: value` lines the next step needs.

### Conditionals in prompts

Use `{{#if var}}content{{/if}}` to include content only when a variable is non-empty:

```yaml
prompt: |
  Task: {{task_name}}
  {{#if human_feedback}}Human guidance: {{human_feedback}}{{/if}}

  ... rest of prompt
```

Unresolved variables (no matching key from prior steps) render as empty string.

### Human feedback (waiting state)

A step can pause execution, post a question to Notion, and resume once a human responds. Use `STATUS: waiting` with a `WAITING_FOR:` question:

```
STATUS: waiting
WAITING_FOR: Should this target enterprise developers or indie hackers? Research supports both.
```

What happens:

1. NotionFlow stores step variables to the DB and records `waiting_since`
2. Posts a "🤔 Feedback needed" callout to the Notion page with the question and instructions: _"Type your answer as a new paragraph on this page, then set State → Queue to resume"_
3. Sets Notion State to "Waiting"
4. Human types their answer directly on the Notion page (as a new paragraph — not a comment)
5. Human sets Notion State → Queue
6. Next `integrations notion sync --run`: task resumes from this step with `{{human_feedback}}` injected

The step prompt should handle both the first run (no feedback yet) and the resume (feedback available):

```yaml
- id: angle-selection
  icon: 🎯
  agent: claude
  prompt: |
    Choose the best angle for this piece.

    Topic: {{task_name}}
    Research: {{research_angles}}
    {{#if human_feedback}}Human guidance: {{human_feedback}}{{/if}}

    If the research supports multiple strong angles and you genuinely cannot choose,
    ask the human:
    STATUS: waiting
    WAITING_FOR: <specific question — what exactly you need to know>

    Otherwise commit to the best angle:
    STATUS: done
    ANGLE: <chosen angle>
    REASONING: <why this angle>
```

### Example (code factory)

```yaml
id: code-factory
name: Code Factory
steps:
  - id: plan
    icon: 📋
    agent: code-factory_planner
    prompt: |
      Break this task into ordered, implementable stories.

      Task: {{task_name}}
      Context: {{task_context}}
      {{#if human_feedback}}Human clarification: {{human_feedback}}{{/if}}

      Explore the codebase first, then produce a concrete plan.

      If the task is genuinely ambiguous:
      STATUS: waiting
      WAITING_FOR: <your specific question>

      Otherwise:
      STATUS: done
      PLAN: <implementation strategy>
      STORIES: <ordered steps separated by | characters>
      FILES_TO_CHANGE: <comma-separated list>
    timeout: 900
    retries: 1
    on_success: next
    on_fail: blocked

  - id: implement
    icon: 💻
    agent: code-factory_developer
    prompt: |
      Implement the plan.

      Task: {{task_name}}
      Plan: {{plan_plan}}
      Stories: {{plan_stories}}
      Files to change: {{plan_files_to_change}}

      Write clean, idiomatic code. Run existing tests. Commit your changes.

      STATUS: done
      CHANGES: <summary of what was implemented>
      FILES_CHANGED: <comma-separated list>
      TESTS_RUN: <test results or "none">
    timeout: 1800
    retries: 1
    on_success: next
    on_fail: blocked

  - id: verify
    icon: 🧪
    agent: code-factory_verifier
    prompt: |
      Verify the implementation.

      Plan: {{plan_plan}}
      Changes: {{implement_changes}}
      Tests: {{implement_tests_run}}

      STATUS: done
      VERDICT: <approved or needs-work>
      ISSUES: <any problems found, or "none">
    timeout: 900
    retries: 0
    on_success: done
    on_fail: blocked
```

## Phase 5 — Connect Board

```bash
npx notionflow integrations notion provision-board --board <factory>
```

This creates a Notion database with:

- **State** column — operational states: Queue / In Progress / Waiting / Done / Blocked / Failed
- **Status** column — step labels (e.g. `📋 plan`, `💻 implement`), auto-derived from the workflow

Remind the user to **share the database with the "NotionFlow" integration** in Notion (click `...` → "Connect to" → select "NotionFlow").

## Phase 6 — End-to-End Test

Run a complete smoke test through every step of the factory:

```bash
# Create a test task in Queue state
npx notionflow integrations notion create-task --board <factory> --title "Test: <short description>" --workflow <factory> --status queue

# Run it
npx notionflow integrations notion sync --board <factory> --run
```

Watch the output. Each step should print `step <id> via <executor>: done`. The Notion page should show State advancing from "In Progress" through each step's Status label to "Done".

### Testing human feedback

If your factory has steps that can output `STATUS: waiting`:

1. Create a task with an ambiguous or intentionally vague title so the step asks for clarification
2. Run `integrations notion sync --board <factory> --run`
3. The step outputs `STATUS: waiting` — task pauses
4. Open Notion — you'll see a "🤔 Feedback needed" callout with the question and instructions
5. Type your answer as a new paragraph on the page
6. Set State → Queue in Notion
7. Run `integrations notion sync --board <factory> --run` again
8. The step resumes with your answer in `{{human_feedback}}`

### Testing failure recovery

1. Edit an executor to temporarily output `STATUS: failed` at the top (before the real command runs)
2. Run the task — it should reach "Failed" state in Notion
3. Revert the executor
4. Set State → Queue in Notion, run sync again — confirms tasks restart cleanly

## Phase 7 — Verify

```bash
npx notionflow executor list
npx notionflow workflow list
npx notionflow executor describe --id <factory>_<first-role>
```

## CLI Cheat Sheet

```bash
# Check what's registered
npx notionflow executor list
npx notionflow workflow list
npx notionflow board list
npx notionflow doctor

# Create and run tasks
npx notionflow integrations notion create-task --board <id> --title "..." --workflow <id> --status queue
npx notionflow integrations notion sync --board <id> --run

# Run a specific task directly (bypasses sync)
npx notionflow run --task <notion-page-id>

# Re-install an executor after editing it
npx notionflow executor install --path ~/.config/notionflow/agents/<id> --id <id>

# Re-install a workflow after editing its YAML
npx notionflow workflow install --path ~/.config/notionflow/workflows/<id>.yaml
```

## Modifying Later

- **Swap a command:** Edit `~/.config/notionflow/agents/<factory>_<role>`. Change the command line. No re-registration needed — the file is read on every execution.
- **Add a role:** Create a new executor, register it, add a step to the workflow YAML, re-install the workflow.
- **Change agent behaviour:** Configure the underlying agent directly (OpenClaw: `openclaw agents`, Claude: its own config). NotionFlow only routes the prompt.
- **Change the prompt:** Edit `~/.config/notionflow/workflows/<factory>.yaml` and re-install the workflow.

## Common Gotchas

**`--add-dir` eats the prompt**
`claude --add-dir "$DIR" "$PROMPT"` — Claude's parser treats `$PROMPT` as a second `--add-dir` argument. Fix: always use `--` before `"$PROMPT"` when there are flags before it.

**Unresolved `{{variables}}` render as empty**
If `{{plan_plan}}` is empty in the next step's prompt, the prior step didn't output a `PLAN:` line, or the key was different (e.g. `Plan:` with capital P). Check `parseKeyValues` only matches `KEY: value` (letter start, colon, space, value).

**Notion State vs Status**

- **State** = operational lifecycle (Queue → In Progress → Waiting → Done / Blocked / Failed)
- **Status** = which step is currently running (set by NotionFlow, matches step icons)
  Never manually set Status — NotionFlow controls it.

**Task loops on waiting**
If a task stays waiting after you add feedback, the `{{human_feedback}}` variable was empty — either the paragraph was added before `waiting_since`, or it wasn't a plain paragraph block (e.g. a callout). Type a regular paragraph, not a styled block.

**`tick` with `--board` produces no output**
Use `integrations notion sync --board <id> --run` instead of `tick --board <id>`. The sync command is more reliable for board-scoped operations.
