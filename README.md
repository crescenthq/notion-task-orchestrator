# NotionFlow

Project-local orchestration CLI and typed library for running TypeScript
`definePipe` factories against Notion tasks.

## Local-First Model

NotionFlow runs inside your project directory.

Each project contains:

- `notionflow.config.ts`
- `pipes/`
- `.notionflow/` (runtime DB + logs)

`run` and `tick` load factories from top-level `pipes/` by default, or from
custom declarations in `notionflow.config.ts`.

## Prerequisites

- Node.js 20+
- `NOTION_API_TOKEN`

## Quickstart

```bash
# 1) Initialize a local project
npx notionflow init

# 2) Scaffold a definePipe factory
npx notionflow factory create --id demo --skip-notion-board

# 3) Validate config + auth resolution
npx notionflow doctor

# 4) Run one queue tick
npx notionflow tick --factory demo
```

You can run commands from anywhere in the project tree. NotionFlow walks up
until it finds `notionflow.config.ts`.

## Config Discovery Rules

- Default: walk up from current working directory to find `notionflow.config.ts`
- Override: pass `--config <path>` on project-scoped commands (`doctor`,
  `factory create`, `run`, `tick`, `integrations notion sync`)
- Project root is the directory containing the resolved config file

## Config Format

```ts
import {defineConfig} from 'notionflow'

export default defineConfig({
  name: 'Asmara Tasks',
})
```

Shared board setup uses `name` from `defineConfig(...)` as the Notion database
title. If `name` is omitted, NotionFlow falls back to a title derived from the
project directory name.

If `pipes` is omitted or empty, NotionFlow scans loadable modules in the
top-level `./pipes/` directory.

Use `pipes` only when you want custom locations or tighter filtering:

```ts
import {defineConfig} from 'notionflow'

export default defineConfig({
  pipes: [
    './pipes',
    './manual/critical-review.ts',
    {
      directory: './packages/factories',
      recursive: true,
      match: /^team-a\/.*\.ts$/,
    },
  ],
})
```

Factory discovery stays deterministic:

- Relative file and directory declarations resolve from project root
- Default `./pipes` discovery is top-level only
- Directory declarations can opt into recursive scans with `match: RegExp`
- Missing explicit paths fail fast with diagnostics
- Duplicate factory IDs fail startup with conflict diagnostics

## Runtime Artifacts

NotionFlow writes runtime state under `.notionflow/`:

- `.notionflow/notionflow.db`
- `.notionflow/runtime.log`
- `.notionflow/errors.log`

## Core Commands

```bash
notionflow init
notionflow doctor [--config <path>]
notionflow factory create --id <factory-id> [--config <path>] [--skip-notion-board]
notionflow tick [--loop] [--interval-ms <ms>] [--config <path>] [--board <id>] [--factory <id>]
notionflow run --task <notion_page_id> [--config <path>]
notionflow integrations notion setup [--url <notion-database-url>] [--config <path>]
notionflow integrations notion repair-task --task <notion_page_id> [--config <path>]
notionflow integrations notion create-task --factory <factory-id> --title "title" [--status <state>] [--config <path>]
notionflow integrations notion sync [--config <path>] [--factory <factory-id>] [--run]
```

## Canonical Library API

Package-root authoring API:

- `defineConfig`
- `definePipe`
- `flow`
- `step`
- `ask`
- `decide`
- `loop`
- `write`
- `end`

Reference contract:

- [`docs/definepipe-v1-api-contract.ts`](./docs/definepipe-v1-api-contract.ts)
- [`docs/definepipe-v1-api-contract.md`](./docs/definepipe-v1-api-contract.md)

### definePipe Example

```ts
import {ask, decide, definePipe, end, flow, loop, step, write} from 'notionflow'

type Ctx = {
  decision: 'approve' | 'revise' | ''
  ready: boolean
  revisions: number
}

const draft = step<Ctx>('draft', ctx => ({...ctx, ready: false, revisions: 0}))

const collect = ask<Ctx>('Reply with approve or revise.', (ctx, reply) => {
  const normalized = reply.trim().toLowerCase()
  if (normalized === 'approve' || normalized === 'revise') {
    return {...ctx, decision: normalized as 'approve' | 'revise'}
  }

  return {
    type: 'await_feedback',
    prompt: 'Please reply with "approve" or "revise".',
    ctx,
  }
})

const revise = loop<Ctx>({
  body: step('revise', ctx => ({
    ...ctx,
    revisions: ctx.revisions + 1,
    ready: true,
  })),
  until: ctx => ctx.ready,
  max: 2,
  onExhausted: end.failed('Revision loop exhausted'),
})

export default definePipe({
  id: 'demo',
  initial: {decision: '', ready: false, revisions: 0} satisfies Ctx,
  run: flow(
    draft,
    collect,
    decide(ctx => (ctx.decision === 'revise' ? 'revise' : 'publish'), {
      revise,
      publish: flow(
        write(ctx => ({markdown: `# Result\nDecision: ${ctx.decision}`})),
        end.done(),
      ),
    }),
  ),
})
```

### Feedback Suspend/Resume

`ask` is first-class feedback control:

- No reply available: returns `await_feedback` and task moves to `feedback`
- Prompt is persisted and can be posted back to Notion comments
- Resume path: when a human reply is available, runtime reads feedback,
  continues from persisted context, and clears consumed `human_feedback`

Common live loop:

1. `notionflow tick --factory <factory-id>` pauses in `feedback`.
2. Human replies in Notion comments.
3. `notionflow integrations notion sync --run` detects new comments, re-queues
   feedback tasks, and runs queued work.
4. `notionflow integrations notion setup --config notionflow.config.ts` creates
   or resolves the shared board once before starting tick loops.

## Agent Wrappers (`defineAgent`)

`createOrchestration` and utility contracts (`invokeAgent`, `runCommand`,
`askForRepo`) were removed from the public API.

Authoring now has two explicit layers:

- orchestration primitives (`definePipe`, `flow`, `step`, `ask`, `decide`,
  `loop`, `write`, `end`)
- callable capability wrappers (`defineAgent`) for remote services or CLI tools

```ts
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {defineAgent, definePipe, end, flow, step} from 'notionflow'

const execFileAsync = promisify(execFile)

const planner = defineAgent<{prompt: string}, {text: string; repo: string}>({
  id: 'planner.remote',
  timeoutMs: 20_000,
  retry: {attempts: 3, delay: 250},
  call: async ({prompt}) => {
    // Replace with your provider SDK/HTTP client.
    return {
      text: `planned: ${prompt}`,
      repo: 'https://github.com/acme/demo',
    }
  },
})

const gitStatus = defineAgent<{cwd: string}, {stdout: string}>({
  id: 'git.status',
  retry: {attempts: 2, delay: 100},
  call: async ({cwd}) => {
    const {stdout} = await execFileAsync('git', ['status', '--short'], {cwd})
    return {stdout}
  },
})

const plan = step('plan', async ctx => {
  const planned = await planner.invoke({prompt: 'Draft plan and choose repo'})
  if (!planned.ok) return {...ctx, failure: planned.error.message}

  const status = await gitStatus.invoke({cwd: process.cwd()})
  if (!status.ok) return {...ctx, failure: status.error.message}

  return {
    ...ctx,
    plan: planned.value.text,
    repo: planned.value.repo,
    status: status.value.stdout,
  }
})

export default definePipe({
  id: 'service-layer-demo',
  initial: {plan: '', repo: '', status: '', failure: ''},
  run: flow(plan, end.done()),
})
```

`defineAgent` error defaults when `mapError` is omitted:

- timeout errors map to `code: 'timeout'`
- abort/cancel errors map to `code: 'aborted'`
- all other failures map to `code: 'call_error'` with attempt context

Customize `mapError` when your provider exposes stable domain codes that you
want to branch on in workflow logic. If custom `mapError` throws, runtime falls
back to the same default mapping above.

## Examples

Project-style examples are in [`example-factories/`](./example-factories):

- explicit `notionflow.config.ts`
- definePipe-only factories under `pipes/`
- shared helper import patterns for reusable steps/selectors

## Verification Checklist

Local gate:

```bash
npm run check
npm run lint
npm run test
npm run test:e2e
```

Live Notion API e2e gate (explicit):

1. Set required env vars (if omitted, live-only e2e will fail fast with a clear
   error).

```bash
export NOTION_API_TOKEN="<integration-token>"
# optional: reuse a previously created shared tasks database
export NOTION_TASKS_DATABASE_ID="<database-id>"
# optional: use local DB feedback injection instead of Notion comments
export NOTIONFLOW_VERIFY_FEEDBACK_MODE=local
```

2. Run live smoke + primitive live suites.

```bash
npm run test:e2e -- e2e/local-project-docs-quickstart-live.test.ts
npm run test:e2e -- e2e/canonical-write-live.test.ts e2e/canonical-end-live.test.ts e2e/example-factories-live.test.ts
npm run test:e2e -- e2e/factory-verification.test.ts
```

3. Validate expected outcomes.

- Quickstart live test output includes `Project root:`, `Config path:`,
  `Task created:`, and `Sync complete:`
- Verification suite prints
  `Artifact: .../e2e/artifacts/factory-live-verification-<timestamp>.json`
- Artifact JSON contains `passedScenarios` and per-scenario `finalState`
  terminal outcomes (`done`, `blocked`, `failed`) with tick timelines

## Scratchpad

Run a local playground for interactive TypeScript experiments:

```bash
npm run playground
```

Then open `http://127.0.0.1:4173`.

## Docs

- [CLI Reference](./docs/cli-reference.md)
- [Factory Authoring](./docs/factory-authoring.md)
- [Scratchpad Playground](./docs/scratchpad-playground.md)
- [definePipe v1 API Contract (TypeScript)](./docs/definepipe-v1-api-contract.ts)
- [definePipe v1 API Contract (Overview)](./docs/definepipe-v1-api-contract.md)
- [Architecture](./docs/architecture.md)
