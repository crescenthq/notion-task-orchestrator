# NotionFlow

Project-local orchestration CLI and typed library for running TypeScript
`definePipe` factories against Notion tasks.

## Local-First Model

NotionFlow runs inside your project directory.

Each project contains:

- `notionflow.config.ts`
- `factories/`
- `.notionflow/` (runtime DB + logs)

`run` and `tick` load factories only from paths declared in
`notionflow.config.ts`.

## Prerequisites

- Node.js 20+
- `NOTION_API_TOKEN`

## Quickstart

```bash
# 1) Initialize a local project
npx notionflow init

# 2) Scaffold a definePipe factory
npx notionflow factory create --id demo --skip-notion-board

# 3) Declare the factory in notionflow.config.ts
# factories: ["./factories/demo.ts"]

# 4) Validate config + auth resolution
npx notionflow doctor

# 5) Run one queue tick
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
  factories: ['./factories/demo.ts', './factories/shared-helper-demo.ts'],
})
```

Factory declarations are explicit and deterministic:

- Relative paths resolve from project root
- Missing paths fail fast with diagnostics
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
notionflow integrations notion provision-board --board <board-id>
notionflow integrations notion create-task --board <board-id> --title "..." [--factory <factory-id>]
notionflow integrations notion sync [--config <path>] [--board <board-id>] [--factory <factory-id>] [--run]
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

1. `notionflow tick --board <board-id> --factory <factory-id>` pauses in
   `feedback`.
2. Human replies in Notion comments.
3. `notionflow integrations notion sync --board <board-id> --run` detects new
   comments, re-queues feedback tasks, and runs queued work.

## Orchestration Service Layer

Use layer-backed orchestration utilities (`askForRepo`, `invokeAgent`,
`agentSandbox`) for provider-agnostic integration.

```ts
import {
  createOrchestrationLayer,
  createOrchestrationUtilitiesFromLayer,
  definePipe,
  end,
  flow,
  step,
} from 'notionflow'

const layer = createOrchestrationLayer({
  askForRepo: {
    request: async () => ({
      repo: 'https://github.com/acme/demo',
      branch: 'main',
    }),
  },
  invokeAgent: {
    invoke: async ({prompt}) => ({text: `planned: ${prompt}`}),
  },
  agentSandbox: {
    run: async () => ({exitCode: 0, stdout: 'ok', stderr: ''}),
  },
})

const utils = createOrchestrationUtilitiesFromLayer(layer)

const plan = step('plan', async ctx => {
  const repo = await utils.askForRepo({prompt: 'Choose repo'})
  if (!repo.ok) return {...ctx, failure: repo.error.message}

  const result = await utils.invokeAgent({
    prompt: `Draft plan for ${repo.value.repo}`,
  })
  if (!result.ok) return {...ctx, failure: result.error.message}

  return {...ctx, plan: result.value.text}
})

export default definePipe({
  id: 'service-layer-demo',
  initial: {plan: '', failure: ''},
  run: flow(plan, end.done()),
})
```

## Examples

Project-style examples are in [`example-factories/`](./example-factories):

- explicit `notionflow.config.ts`
- definePipe-only factories under `factories/`
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

1. Set required env vars.

```bash
export NOTION_API_TOKEN="<integration-token>"
export NOTION_WORKSPACE_PAGE_ID="<parent-page-id>"
export NOTIONFLOW_RUN_LIVE_E2E=1
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
