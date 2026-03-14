# Factory Authoring Guide

## Canonical Authoring Model

NotionFlow authoring is `definePipe`-only.

Use these package-root APIs:

- `definePipe`
- `flow`
- `step`
- `ask`
- `decide`
- `loop`
- `write`
- `end`

Reference contract:
[`definepipe-v1-api-contract.ts`](./definepipe-v1-api-contract.ts).

Quick try-it path: [`scratchpad-playground.md`](./scratchpad-playground.md).

## Minimal Factory Shape

```ts
import {definePipe, end, flow, step} from 'notionflow'

export default definePipe({
  id: 'my-factory',
  initial: {completed: false},
  run: flow(
    step('complete', ctx => ({...ctx, completed: true})),
    end.done(),
  ),
})
```

## Primitive Semantics

- `step(name, run, assign?)`: run one unit of work and return updated context
- `ask(prompt, parse)`: request human input; returns `await_feedback` when no
  reply is available
- `decide(select, branches, options?)`: route to a branch step/flow by selected
  key
- `loop({body, until, max, onExhausted})`: bounded repeat-until execution
- `write(render)`: render and emit Notion page output (`string` or
  `{markdown, body?}`)
- `end.done()`, `end.blocked()`, `end.failed(message)`: explicit terminal
  outcomes

## Full Composition Example

```ts
import {ask, decide, definePipe, end, flow, loop, step, write} from 'notionflow'

type Context = {
  decision: 'approve' | 'revise' | ''
  ready: boolean
  revisions: number
}

const collectDecision = ask<Context>(
  'Reply with approve or revise.',
  (ctx, reply) => {
    const normalized = reply.trim().toLowerCase()

    if (normalized === 'approve' || normalized === 'revise') {
      return {...ctx, decision: normalized as 'approve' | 'revise'}
    }

    return {
      type: 'await_feedback',
      prompt: 'Please reply with "approve" or "revise".',
      ctx,
    }
  },
)

const reviseUntilReady = loop<Context>({
  body: step('revise', ctx => ({
    ...ctx,
    revisions: ctx.revisions + 1,
    ready: true,
  })),
  until: ctx => ctx.ready,
  max: 2,
  onExhausted: end.failed('Revision loop exhausted before ready state'),
})

export default definePipe({
  id: 'approval-demo',
  initial: {
    decision: '',
    ready: false,
    revisions: 0,
  } satisfies Context,
  run: flow(
    collectDecision,
    decide(ctx => (ctx.decision === 'revise' ? 'revise' : 'publish'), {
      revise: flow(reviseUntilReady),
      publish: flow(
        write(ctx => ({
          markdown: `# Approval Result\nDecision: ${ctx.decision}`,
        })),
        end.done(),
      ),
    }),
  ),
})
```

For runnable examples, see
[`example-factories/factories/`](../example-factories/factories).

## Feedback Suspend/Resume Lifecycle

`ask` is stateful and resume-safe.

- If no feedback is present, `ask` emits `await_feedback` and runtime moves task
  to `feedback`
- Runtime persists context + prompt and writes feedback traces
  (`await_feedback`)
- On resume, runtime restores persisted context, consumes feedback, and emits a
  `resumed` trace before continuing

Feedback sources consumed by `ask`:

- `input.feedback` (direct input)
- persisted `ctx.human_feedback` (resume path)

Typical Notion loop:

1. `notionflow tick --factory <factory-id>` pauses task in
   `feedback`.
2. Human replies in Notion comments.
3. `notionflow integrations notion sync --run` detects new
   comments, stores `human_feedback`, re-queues the task, and runs queued work.
4. `notionflow integrations notion connect --url <notion-database-url> --config <path>`
   registers the shared board in a new environment before running the first
   tick.

## Agent Wrapper Setup (`defineAgent`)

`createOrchestration` and utility contracts (`invokeAgent`, `runCommand`,
`askForRepo`) were removed. Use `defineAgent` wrappers for external
capabilities, and keep orchestration logic in `definePipe` primitives.

### Production Wiring (Remote + CLI Capabilities)

```ts
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {defineAgent, definePipe, end, flow, step} from 'notionflow'

const execFileAsync = promisify(execFile)

const selectRepo = defineAgent<
  {prompt: string},
  {repo: string; branch: string; reason: string},
  'provider_unavailable' | 'invalid_response' | (string & {})
>({
  id: 'repo-selector.remote',
  timeoutMs: 20_000,
  retry: {attempts: 3, delay: 300},
  call: async ({prompt}) => {
    // Replace with provider SDK/HTTP call.
    return {
      repo: 'https://github.com/acme/demo',
      branch: 'main',
      reason: `selected for prompt: ${prompt}`,
    }
  },
  mapError: error => {
    if (error instanceof Error && error.message.includes('HTTP 503')) {
      return {
        code: 'provider_unavailable',
        message: error.message,
        cause: error,
      }
    }

    return {
      code: 'invalid_response',
      message: 'repo selector failed',
      cause: error,
    }
  },
})

const gitStatus = defineAgent<{cwd: string}, {stdout: string}>({
  id: 'git.status.cli',
  retry: {attempts: 2, delay: 100},
  call: async ({cwd}) => {
    const {stdout} = await execFileAsync('git', ['status', '--short'], {cwd})
    return {stdout}
  },
})

const runPlanning = step('run-planning', async ctx => {
  const repo = await selectRepo.invoke({
    prompt: 'Select repository for rollout',
  })
  if (!repo.ok) return {...ctx, failure: repo.error.message}

  const status = await gitStatus.invoke({cwd: process.cwd()})
  if (!status.ok) return {...ctx, failure: status.error.message}

  return {
    ...ctx,
    repo: repo.value.repo,
    branch: repo.value.branch,
    planReason: repo.value.reason,
    status: status.value.stdout,
  }
})

export default definePipe({
  id: 'service-layer-demo',
  initial: {repo: '', branch: '', planReason: '', status: '', failure: ''},
  run: flow(runPlanning, end.done()),
})
```

### Default `mapError` Behavior

If `mapError` is omitted, `defineAgent` maps failures as:

- `timeout` when a call exceeds timeout
- `aborted` when external or timeout-driven abort is observed
- `call_error` for all other failures with attempt-aware message text

`timeoutMs` applies per attempt. With `retry.attempts > 1`, each attempt gets
its own timeout window.

### When To Customize `mapError`

Customize `mapError` when your workflow needs stable, branchable error codes
from upstream providers or CLI wrappers (for example `provider_unavailable`). If
custom `mapError` throws, NotionFlow falls back to the default mapping.

### Test Wrapper Swaps

```ts
import {defineAgent} from 'notionflow'

const alphaPlanner = defineAgent<{prompt: string}, {text: string}>({
  id: 'planner.alpha',
  call: async () => ({text: 'alpha-plan'}),
})

const betaPlanner = defineAgent<{prompt: string}, {text: string}>({
  id: 'planner.beta',
  call: async () => ({text: 'beta-plan'}),
})
```

## Local Project Workflow

1. Initialize project structure.

```bash
npx notionflow init
```

2. Scaffold a factory.

```bash
npx notionflow factory create --id my-factory --skip-notion-board
```

3. Declare factory file in `notionflow.config.ts`.

```ts
import {defineConfig} from 'notionflow'

export default defineConfig({
  factories: ['./factories/my-factory.ts'],
})
```

If you want board provisioning to use a human-friendly name, add `name` to the
`definePipe` export (for example `name: 'My Factory'`). NotionFlow still uses
the factory `id` as the board key, so you can rename the board in Notion later.

4. Validate context and auth.

```bash
npx notionflow doctor
```

5. Run work via queue or direct task execution.

```bash
npx notionflow tick --factory <factory-id>
npx notionflow run --task <notion_page_id>
```

## Authoring Tips

- Keep context JSON-serializable
- Keep factory `id` stable once tasks are in-flight
- Use `flow(...)` as the default composition style
- Return explicit `end.*` outcomes for deterministic terminals
- Treat agent invocation failures (`result.ok === false`) as explicit workflow
  branches

## Verification Checklist

Local gate:

```bash
npx notionflow doctor
npm run check
npm run lint
npm run test
npm run test:e2e
```

Live Notion API e2e gate (explicit):

1. Required env vars (if omitted, live-only e2e will fail fast with a clear
   error).

```bash
export NOTION_API_TOKEN="<integration-token>"
export NOTION_WORKSPACE_PAGE_ID="<parent-page-id>"
# optional: local DB feedback injection for verification suite
export NOTIONFLOW_VERIFY_FEEDBACK_MODE=local
```

2. Live command sequence.

```bash
npm run test:e2e -- e2e/local-project-docs-quickstart-live.test.ts
npm run test:e2e -- e2e/canonical-write-live.test.ts e2e/canonical-end-live.test.ts e2e/example-factories-live.test.ts
npm run test:e2e -- e2e/factory-verification.test.ts
```

3. Expected outputs.

- Quickstart test prints `Project root:`, `Config path:`, `Task created:`, and
  `Sync complete:`
- Verification suite prints
  `Artifact: .../e2e/artifacts/factory-live-verification-<timestamp>.json`
- Artifact JSON includes `passedScenarios` and per-scenario terminal
  `finalState` entries
