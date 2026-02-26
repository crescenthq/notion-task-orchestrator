# NotionFlow v2 RFC

Status: Draft  
Date: 2026-02-26

## 1. Vision

NotionFlow v2 is a small orchestration kernel for human+agent task execution.

Core promise:

1. Deterministic state transitions.
2. Durable local state.
3. Thin sync with task surfaces (starting with Notion).

Agent choice should not matter. Scheduler choice should not matter. The kernel should be boring, reliable, and easy to reason about.

## 2. Design Tenets

- Agent-agnostic protocol, no vendor lock-in.
- Per-step heterogeneous executors (Claude/OpenClaw/shell/custom in one workflow).
- SQLite as canonical state (not page properties, not JSON files).
- Deterministic `tick` execution (idempotent single cycle).
- Human unblock loop is first-class (`blocked` -> comment -> `queued`).
- Small CLI surface area.

## 3. Non-Goals

- No embedded production scheduler requirement.
- No heavy workflow runtime dependencies in core.
- No notion-first data model.
- No dashboard requirement in core.

## 4. Source-Informed Product Shape

This RFC aligns with proven patterns:

- Antfarm: deterministic workflow steps, retry/escalate semantics, and SQLite-backed orchestration.
- Geoffrey Litt kanban workflow: blocked task turns visually urgent (red), human replies on card, orchestration resumes from that input.

## 5. Architecture

## 5.1 Modules

- `core/`: workflow evaluator + transition table + guards.
- `store/`: SQLite schema, repositories, transactions.
- `adapters/notion/`: inbound polling and outbound projections.
- `adapters/agent/`: process runner for `describe` and `execute` contract.
- `cli/`: command entry points and user UX.

## 5.2 Canonical vs Projected State

- Canonical state lives in SQLite.
- Notion receives projection updates (`Status`, progress summary), but does not hold canonical orchestration internals.

## 6. State Machine

## 6.1 Task States

- `queued`
- `claimed`
- `running`
- `blocked`
- `done`
- `failed`

## 6.2 Transition Rules

```text
queued -> claimed   (claim lock succeeds)
claimed -> running  (step execution starts)
running -> running  (advance to next step)
running -> blocked  (STATUS: blocked, retries exhausted, or missing required input)
running -> done     (terminal success)
running -> failed   (terminal unrecoverable failure)
blocked -> queued   (new human unblock input accepted)
failed -> queued    (manual retry)
```

## 6.3 Implementation Strategy

Use a typed TypeScript transition table in core.

Why:

- Minimal dependency footprint.
- Exhaustive compile-time transition checks.
- Easier long-term maintainability.

XState can be added later for visualization/export without changing runtime semantics.

## 7. Persistence: SQLite Schema

```sql
CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  adapter TEXT NOT NULL,
  external_id TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  definition_yaml TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE executors (
  id TEXT PRIMARY KEY,                     -- e.g. claude, openclaw, shell
  command_path TEXT NOT NULL,             -- executable path
  default_timeout_seconds INTEGER,
  default_retries INTEGER,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  external_task_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  state TEXT NOT NULL,
  current_step_id TEXT,
  lock_token TEXT,
  lock_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(board_id, external_task_id),
  FOREIGN KEY(board_id) REFERENCES boards(id),
  FOREIGN KEY(workflow_id) REFERENCES workflows(id)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE TABLE step_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  executor_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  output_text TEXT NOT NULL,
  output_kv_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id),
  FOREIGN KEY(executor_id) REFERENCES executors(id)
);

CREATE TABLE inbox_events (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  task_id TEXT,
  source TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source, fingerprint),
  FOREIGN KEY(board_id) REFERENCES boards(id),
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE TABLE board_cursors (
  board_id TEXT PRIMARY KEY,
  comments_cursor TEXT,
  tasks_cursor TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(board_id) REFERENCES boards(id)
);
```

## 8. Notion Adapter Contract

## 8.1 Minimal required properties

- `Name` (title)
- `Status` (status/select)
- `Ready` (checkbox)

Optional projected properties:

- `Current action`
- `Last update at`

Notion should not carry canonical lock/session/retry/event internals.

## 8.2 Blocked UX Contract

When blocked:

1. Project `Status=blocked` to Notion.
2. Append one precise unblock question to the page.
3. Ingest human comments as inbox events (deduped).
4. Transition task back to `queued` when unblock input is sufficient.

## 9. Agent Adapter Contract

Any executable can be an agent if it supports:

- `AGENT_ACTION=describe` -> metadata to stdout.
- `AGENT_ACTION=execute` -> JSON on stdin, text on stdout.

This matches the v1 wrapper model (`agents/claude`, `agents/openclaw`, `agents/shell`):

- same envelope,
- different backend CLIs,
- swappable per step.

Core parser conventions:

- `STATUS: done|blocked|retry|failed`
- `KEY: value` lines become downstream template variables.

## 9.1 Per-step executor routing (hard requirement)

Workflows must be able to mix executors by step, for example:

- `plan` -> `claude`
- `build` -> `openclaw`
- `verify` -> `shell`

The orchestrator resolves each step's `agent` field to an executor entry and invokes that executable with the shared contract.

## 9.2 Execute payload (baseline)

```json
{
  "prompt": "...",
  "session_id": "task-uuid",
  "workdir": "/repo/or/path",
  "timeout": 600,
  "step_id": "plan",
  "task_id": "...",
  "run_id": "..."
}
```

Executors may ignore fields they do not need.

## 10. Workflow DSL (v2)

Keep it compact:

```yaml
id: default-task
name: Default Task
steps:
  - id: plan
    agent: claude
    prompt: |
      Create a plan for {{task_name}}.
      Context:
      {{task_context}}
      Reply with STATUS: done and PLAN: ...
    timeout: 900
    retries: 1
    on_success: next
    on_fail: blocked
  - id: build
    agent: openclaw
    prompt: |
      Implement from PLAN:
      {{plan_plan}}
      Reply with STATUS: done and SUMMARY: ...
  - id: verify
    agent: shell
    prompt: |
      npm test
      # include STATUS: done if passing
```

Required:

- workflow: `id`, `name`, `steps`
- step: `id`, `agent`, `prompt`

Optional:

- `timeout`, `retries`, `on_success`, `on_fail`

Deferred from v2 core: parallel branches and conditional expressions.

## 11. CLI v2

```bash
notionflow init
notionflow board add --id <id> --adapter notion --external-id <db_id>
notionflow board list
notionflow workflow add <path>
notionflow workflow list
notionflow executor add --id <id> --path <executable>
notionflow executor list
notionflow executor describe <id>
notionflow tick --board <id>
notionflow run --board <id> --task <external_task_id> [--workflow <id>]
notionflow resume --task <external_task_id>
notionflow status [--task <id> | --run <id>]
notionflow doctor
```

Design intent:

- `tick` is the primary orchestration primitive (single deterministic cycle).
- Scheduling is external (cron/systemd/CI/k8s) and user-controlled.

## 12. Tick Algorithm

`tick --board <id>` executes in strict order:

1. Pull external deltas (queue tasks/comments) from Notion.
2. Upsert into local task/event tables with dedup fingerprints.
3. Recover stale claims (expired lock -> `queued`).
4. Claim eligible queued tasks transactionally.
5. Execute one deterministic progression per claimed task (or a bounded number of steps).
6. Persist step outputs and transition decisions.
7. Project latest status/progress back to Notion.

Idempotency rule: repeating the same tick must not duplicate state transitions or comment processing.

## 13. Observability and Ops

- `status` reads from SQLite, not external API.
- Structured event rows in `inbox_events` + run/step tables support debugging.
- `doctor` checks:
  - DB readability/writability
  - board configuration validity
  - notion auth health
  - agent `describe` reachability

## 14. Security and Safety

- Keep agent commands explicit and local.
- Do not auto-install arbitrary remote workflows/agents by default.
- Provide transparent workflow definitions users can review.
- Add execution timeouts and retry ceilings per step.

## 15. Open Questions

1. Should step output truncation be enforced with optional full blob archival?
2. Should comment ingestion be polling-only in v2, or support webhooks now?
3. Should `tick` process one step per task or full run-to-block/done per claim?
4. Should workflow versions be immutable once referenced by a task?

## 16. Definition of Done for v2

v2 is complete when:

1. Orchestration runs entirely from SQLite-backed state.
2. Notion is used as an adapter/projection, not canonical state.
3. `tick` can be repeatedly executed with idempotent behavior.
4. Blocked tasks resume correctly from human comments.
5. Agent integration remains protocol-driven and replaceable.
