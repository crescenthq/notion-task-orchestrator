---
name: add-factory
description: Create a TypeScript state-machine factory with inline agent functions. Use when the user wants to create a factory, build a multi-agent pipeline, or chain states into a workflow.
---

# Create a TypeScript Factory

A factory is a TypeScript state machine. Each state has an inline `agent` function that runs your logic, and an `on` map that routes to the next state based on the result.

**Principle:** One file, all logic inline. No separate executor scripts. No YAML.

## Phase 1 — Design

Use AskUserQuestion: "What kind of factory do you want to create?"

Offer templates as starting points:

- **Code factory** — plan → implement → review → done
- **Content factory** — research → write → review → publish
- **Bug fix factory** — triage → investigate → fix → verify
- **Custom** — describe your own states and logic

Use AskUserQuestion: "What should this factory be called? (e.g. code-factory, content-pipeline)"

Map out the states: what each state does, what agent logic it runs, and what success/failure routes it needs.

## Phase 2 — Scaffold

```bash
npx notionflow factory create --id <factory-id> --skip-notion-board
```

This writes a minimal scaffold to `~/.config/notionflow/workflows/<factory-id>.ts`. Edit it directly — it's just TypeScript.

## Phase 3 — Write the Factory

The factory is an `export default` object with:

- `id` — matches the factory ID
- `start` — initial state ID
- `context` — initial context object (shared across all states)
- `states` — record of state definitions
- `guards` — optional pure functions used by loop `until` and orchestrate `select`

### State Types

**`action`** — runs an async agent function, routes via `on`:

```ts
plan: {
  type: "action",
  agent: async ({ task, ctx }) => {
    // ... agent logic ...
    return { status: "done", data: { plan: "..." } };
  },
  on: { done: "implement", failed: "failed" },
  retries: { max: 2, backoff: "fixed" }, // optional
},
```

The agent receives `{ task, ctx }` and must return:
- `status`: `"done"` | `"feedback"` | `"failed"`
- `data?`: `Record<string, unknown>` — shallow-merged into `ctx` for later states
- `message?`: string — logged to Notion on failure or feedback

**`orchestrate`** — routes to a state via a pure `select` function or an agent router:

```ts
// Deterministic (pure function):
route: {
  type: "orchestrate",
  select: ({ ctx }) => ctx.qualityScore >= 85 ? "publish" : "revise",
  on: { publish: "publish", revise: "revise" },
},

// LLM-driven (agent returns the event key):
route: {
  type: "orchestrate",
  agent: async ({ task, ctx }) => {
    // must return { status: "done", data: { event: "<key in on>" } }
    return { status: "done", data: { event: ctx.score >= 85 ? "publish" : "revise" } };
  },
  on: { publish: "publish", revise: "revise" },
},
```

**`loop`** — repeats a body state up to `maxIterations`, exits via `on`:

```ts
refine_loop: {
  type: "loop",
  body: "refine",        // must match on.continue target
  maxIterations: 3,
  until: "qualityReached", // guard name; emits "done" when true
  on: { continue: "refine", done: "publish", exhausted: "publish" },
},
```

The loop emits `continue` if the guard is false, `done` if the guard is true, `exhausted` if the cap is reached.

**`feedback`** — pauses for human input, resumes when a Notion comment reply arrives:

```ts
await_human: { type: "feedback", resume: "previous" },
```

`resume: "previous"` returns to the state that transitioned here. Or specify an explicit state ID to override.

**Terminal states:**

```ts
done: { type: "done" },
failed: { type: "failed" },
blocked: { type: "blocked" },
```

### Guards

```ts
guards: {
  qualityReached: ({ ctx }) => Number(ctx.qualityScore) >= 85,
},
```

Guards are synchronous and pure — no side effects, no async.

### Calling External Agent CLIs

For states that need to call Claude, Codex, or any CLI tool, spawn the process inline:

```ts
import { spawn } from "node:child_process";

type AgentResult = {
  status: "done" | "feedback" | "failed";
  data?: Record<string, unknown>;
  message?: string;
};

async function callCli(
  args: { command: string; prompt: string; timeoutSeconds?: number }
): Promise<AgentResult> {
  return new Promise((resolve) => {
    const proc = spawn(args.command, ["--print", "--output-format", "json"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => out.push(c));
    proc.on("error", () => resolve({ status: "failed", message: "spawn error" }));
    proc.on("close", (code) => {
      if ((code ?? 1) !== 0) return resolve({ status: "failed", message: "non-zero exit" });
      try {
        resolve(JSON.parse(Buffer.concat(out).toString("utf8").trim()) as AgentResult);
      } catch {
        resolve({ status: "failed", message: "invalid JSON from agent" });
      }
    });
    proc.stdin.write(args.prompt);
    proc.stdin.end();
  });
}
```

**Calling `claude` from inside Claude Code:** prefix the command with `env -u CLAUDECODE` to avoid environment conflicts:

```ts
const proc = spawn(
  "env",
  ["-u", "CLAUDECODE", "claude", "--print", "--output-format", "json"],
  { stdio: ["pipe", "pipe", "pipe"] }
);
```

### Full Example (content factory)

```ts
import { spawn } from "node:child_process";

const research = async ({ task, ctx }) => {
  // inline logic, or call a CLI
  return { status: "done", data: { sources: "..." } };
};

const write = async ({ task, ctx }) => {
  return { status: "done", data: { draft: "..." } };
};

const review = async ({ task, ctx }) => {
  const score = ctx.draft ? 90 : 40;
  if (score < 60) {
    return {
      status: "feedback",
      message: "Draft quality too low — please review and clarify the brief.",
    };
  }
  return { status: "done", data: { qualityScore: score } };
};

export default {
  id: "content-factory",
  start: "research",
  context: { sources: "", draft: "", qualityScore: 0 },
  states: {
    research: {
      type: "action",
      agent: research,
      on: { done: "write", failed: "failed" },
    },
    write: {
      type: "action",
      agent: write,
      on: { done: "review_loop", failed: "failed" },
    },
    review_loop: {
      type: "loop",
      body: "review",
      maxIterations: 3,
      until: "qualityReached",
      on: { continue: "review", done: "done", exhausted: "done" },
    },
    review: {
      type: "action",
      agent: review,
      on: { done: "review_loop", feedback: "await_human", failed: "failed" },
    },
    await_human: { type: "feedback", resume: "previous" },
    done: { type: "done" },
    failed: { type: "failed" },
  },
  guards: {
    qualityReached: ({ ctx }) => Number(ctx.qualityScore) >= 85,
  },
};
```

## Phase 4 — Install

```bash
npx notionflow factory install --path ~/.config/notionflow/workflows/<factory-id>.ts
```

Verify:

```bash
npx notionflow factory list
```

## Phase 5 — Provision Board

```bash
npx notionflow integrations notion provision-board --board <factory-id>
```

Remind the user to **share the database with the "NotionFlow" integration** in Notion (click `...` → "Connect to" → "NotionFlow").

## Phase 6 — End-to-End Test

```bash
# Create a test task in Queue state
npx notionflow integrations notion create-task \
  --board <factory-id> --title "Test: <short description>" \
  --factory <factory-id> --status queue

# Run it
npx notionflow tick
```

Watch the output. Each state should transition and log to Notion.

### Testing human feedback

If a factory state returns `status: "feedback"`:

1. Create a task with an ambiguous or vague title
2. Run `npx notionflow tick`
3. The state returns `status: "feedback"` — task pauses, Notion State becomes "Feedback"
4. Open the Notion page — a comment is posted with the question
5. **Reply to the comment** in Notion (no page editing, no state change needed)
6. Run `npx notionflow tick` again — detects the reply, resumes from where it paused

### Testing retry/failure

1. Temporarily make an agent function return `{ status: "failed", message: "forced fail" }`
2. Run `npx notionflow tick` — state retries up to `retries.max`, then routes via `on.failed`
3. Revert the agent, reset the Notion State to Queue, run `tick` again

## Phase 7 — Verify

```bash
npx notionflow factory list
npx notionflow board list
npx notionflow doctor
```

## CLI Cheat Sheet

```bash
# Manage factories
npx notionflow factory create --id <id>
npx notionflow factory install --path <file.ts>
npx notionflow factory list

# Create and run tasks
npx notionflow integrations notion create-task \
  --board <id> --title "..." --factory <id> --status queue
npx notionflow tick

# Run a specific task directly (bypasses sync)
npx notionflow run --task <notion-page-id>

# Check setup
npx notionflow doctor
npx notionflow board list
```

## Modifying Later

- **Edit logic:** Open the `.ts` factory file, change the inline agent function, re-install with `factory install --path <file.ts>`.
- **Add a state:** Add the state to `states`, wire up `on` maps in affected states, re-install.
- **Change routing:** Update `select` or `orchestrate.agent` return value, update `on` map, re-install.

## Common Gotchas

**Cross-file runtime imports are rejected**
Agent functions (`agent`, `select`, guard functions) must be defined in the same factory file. Importing them from another module causes a load-time validation error. Shared helpers declared in the same file are fine.

**`data` returned by agents is merged into `ctx`**
Whatever you return in `data` is shallow-merged into `ctx` for subsequent states. Later states can read `ctx.myKey` if a prior state returned `data: { myKey: "..." }`.

**Loop `body` must match `on.continue` target**
`loop.body` must equal the state ID in `on.continue`. The runtime validates this at load time.

**Feedback pause resumes on Notion comment reply**
After a state returns `status: "feedback"`, the task only resumes when a Notion comment reply arrives (newer than when the state paused). Only replies — not edits to the agent's original comment — are detected.

**`action` states require both `on.done` and `on.failed`**
Both routes must be declared. The runtime rejects factories missing either route at load time.
