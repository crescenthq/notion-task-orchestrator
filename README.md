# NotionFlow

Project-local orchestration CLI and typed library for running TypeScript
factories against Notion tasks.

## Local-First Model

NotionFlow now runs in a project directory, not a global config directory.

Each project contains:

- `notionflow.config.ts`
- `factories/`
- `.notionflow/` (runtime DB + logs)

`run` and `tick` load factories directly from paths declared in
`notionflow.config.ts`.

## Prerequisites

- Node.js 20+
- `NOTION_API_TOKEN`

## Quickstart

```bash
# 1) Initialize a local NotionFlow project
npx notionflow init

# 2) Scaffold a factory file
npx notionflow factory create --id demo --skip-notion-board

# 3) Declare the factory in notionflow.config.ts
# Edit factories: ["./factories/demo.ts"] into the generated config

# 4) Validate project resolution and auth
npx notionflow doctor

# 5) Run one orchestration tick
npx notionflow tick --factory demo
```

You can run commands from anywhere inside the project tree; NotionFlow walks up
directories to find `notionflow.config.ts`.

## Config Discovery Rules

- Default: walk up from current working directory to find `notionflow.config.ts`
- Override: pass `--config <path>` on project-scoped commands (`doctor`,
  `factory create`, `run`, `tick`, `integrations notion sync`)
- Project root is always the directory containing the resolved config file

## Config Format

```ts
import {defineConfig} from 'notionflow'

export default defineConfig({
  factories: ['./factories/demo.ts', './factories/shared-helper-demo.ts'],
})
```

Factory declarations are explicit and deterministic:

- Relative paths resolve from project root
- Missing paths fail fast with path diagnostics
- Duplicate factory IDs fail startup with conflict diagnostics

## Runtime Artifacts

NotionFlow writes runtime state under `.notionflow/`:

- `.notionflow/notionflow.db`
- `.notionflow/runtime.log`
- `.notionflow/errors.log`

`notionflow init` creates `.notionflow/` and ensures it is in `.gitignore`.

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

## Library API

Use package-root typed APIs to author config, runtime factories, and expressive
primitives:

```ts
import {
  agent,
  ask,
  defineConfig,
  defineFactory,
  end,
  loop,
  publish,
  retry,
  route,
  step,
} from 'notionflow'

const doWork = agent(async ({ctx}) => ({
  status: 'done',
  data: {...ctx, completed: true},
}))

export const demoFactory = defineFactory({
  id: 'demo',
  start: 'start',
  context: {},
  states: {
    start: {
      type: 'action',
      agent: doWork,
      on: {done: 'done', failed: 'failed'},
    },
    done: {type: 'done'},
    failed: {type: 'failed'},
  },
})

export default defineConfig({
  factories: ['./factories/demo.ts'],
})
```

### Expressive Primitive Surface

The public expressive primitive builders are:

- `step({run, on, retries?})`
- `ask({prompt, parse?, on, resume?})`
- `route({select, on})`
- `loop({body, maxIterations, until?, on})`
- `retry({max, backoff?})`
- `publish({render, on?})`
- `end({status: 'done' | 'blocked' | 'failed'})`

Use `publish` for page output and `end` for terminal outcomes. Legacy
replacement aliases are intentionally not documented or exported.

A runnable primitive-composed workflow is available at
[`example-factories/factories/expressive-primitives.ts`](./example-factories/factories/expressive-primitives.ts).

### Provider-Agnostic Orchestration Utilities

`askForRepo`, `invokeAgent`, and `agentSandbox` return `UtilityResult<T>` and
are intended to be injected with adapters.

```ts
import {createOrchestrationUtilities} from 'notionflow'

const orchestration = createOrchestrationUtilities({
  askForRepo: {
    request: async () => ({repo: 'https://github.com/acme/demo', branch: 'main'}),
  },
  invokeAgent: {
    invoke: async () => ({text: 'Plan ready'}),
  },
  agentSandbox: {
    run: async () => ({exitCode: 0, stdout: 'ok', stderr: ''}),
  },
})

const repoResult = await orchestration.askForRepo({
  prompt: 'Which repo should we work on?',
  timeoutMs: 15000,
})
if (!repoResult.ok) throw new Error(repoResult.error.message)

const planResult = await orchestration.invokeAgent({
  prompt: `Draft a plan for ${repoResult.value.repo}`,
})
if (!planResult.ok) throw new Error(planResult.error.message)
```

## Examples

Project-style examples are in [`example-factories/`](./example-factories):

- explicit `notionflow.config.ts`
- factories under `factories/`
- shared runtime helper import example
- setup notes and runnable commands

## Verification Checklist

```bash
npm run check
npm run lint
npm run test
npm run test:e2e
```

## Docs

- [CLI Reference](./docs/cli-reference.md)
- [Factory Authoring](./docs/factory-authoring.md)
- [Architecture](./docs/architecture.md)
