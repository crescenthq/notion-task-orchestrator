# Factory Authoring Guide

## Authoring Modes

NotionFlow supports two factory authoring styles:

- Runtime-state authoring with `defineFactory(...)`
- Expressive primitive authoring with `step`, `ask`, `route`, `loop`, `retry`,
  `publish`, and `end`

`publish` and `end` are the canonical output/terminal primitive names.
Legacy replacement aliases are intentionally not part of the docs or public API.

## Runtime Factory Shape

A runtime-state factory is a default export state machine:

```ts
import {defineFactory} from 'notionflow'

export default defineFactory({
  id: 'my-factory',
  start: 'start',
  context: {},
  states: {
    start: {
      type: 'action',
      agent: async ({ctx}) => ({status: 'done', data: ctx}),
      on: {done: 'done', failed: 'failed'},
    },
    done: {type: 'done'},
    failed: {type: 'failed'},
  },
})
```

## Expressive Primitive API

Package-root primitive builders:

- `step({run, on, retries?})` for action work
- `ask({prompt, parse?, on, resume?})` for feedback pause/resume
- `route({select, on})` for deterministic branching
- `loop({body, maxIterations, until?, on})` for bounded iteration
- `retry({max, backoff?})` for transient retry policy
- `publish({render, on?})` for page output
- `end({status})` for terminal states (`done`, `blocked`, `failed`)

Primitive composition example (state fragments):

```ts
import {ask, end, loop, publish, retry, route, step} from 'notionflow'

const states = {
  collect_input: ask({
    prompt: 'Reply with approve or revise.',
    on: {done: 'decide', failed: 'failed'},
  }),
  decide: route({
    select: ({ctx}) => (ctx.decision === 'approve' ? 'publish' : 'revise'),
    on: {publish: 'publish_result', revise: 'revise_loop'},
  }),
  revise_loop: loop({
    body: 'revise_step',
    maxIterations: 2,
    until: ({ctx}) => Boolean(ctx.ready),
    on: {continue: 'revise_step', done: 'publish_result', exhausted: 'failed'},
  }),
  revise_step: step({
    run: async ({ctx}) => ({status: 'done', data: {...ctx, ready: true}}),
    retries: retry({max: 1, backoff: {strategy: 'fixed', ms: 250}}),
    on: {done: 'revise_loop', failed: 'failed'},
  }),
  publish_result: publish({
    render: ({ctx}) => ({markdown: `# Result\nReady: ${ctx.ready}`}),
    on: {done: 'done', failed: 'failed'},
  }),
  done: end({status: 'done'}),
  failed: end({status: 'failed'}),
}
```

For a full runnable flow, see
[`example-factories/factories/expressive-primitives.ts`](../example-factories/factories/expressive-primitives.ts).

## Provider-Agnostic Orchestration Utilities

`askForRepo`, `invokeAgent`, and `agentSandbox` return `UtilityResult<T>` and
share the same usage pattern:

1. Inject adapters once with `createOrchestrationUtilities(...)`.
2. Call utility methods inside an action/step handler.
3. Check `result.ok` before reading `result.value`.
4. Use `timeoutMs` at call time (or utility options) for operation bounds.

```ts
import {createOrchestrationUtilities, defineFactory} from 'notionflow'

const utils = createOrchestrationUtilities({
  askForRepo: {
    request: async () => ({repo: 'https://github.com/acme/demo', branch: 'main'}),
  },
  invokeAgent: {
    invoke: async ({prompt}) => ({text: `processed: ${prompt}`}),
  },
  agentSandbox: {
    run: async () => ({exitCode: 0, stdout: 'ok', stderr: ''}),
  },
})

export default defineFactory({
  id: 'utility-pattern-demo',
  start: 'run',
  context: {},
  states: {
    run: {
      type: 'action',
      agent: async ({ctx}) => {
        const repo = await utils.askForRepo({prompt: 'Pick repo', timeoutMs: 10000})
        if (!repo.ok) return {status: 'failed', message: repo.error.message}

        const plan = await utils.invokeAgent({
          prompt: `Draft a plan for ${repo.value.repo}`,
        })
        if (!plan.ok) return {status: 'failed', message: plan.error.message}

        const sandbox = await utils.agentSandbox({
          command: 'echo',
          args: ['ok'],
        })
        if (!sandbox.ok) return {status: 'failed', message: sandbox.error.message}

        return {
          status: 'done',
          data: {...ctx, plan: plan.value.text, sandbox_stdout: sandbox.value.stdout},
        }
      },
      on: {done: 'done', failed: 'failed'},
    },
    done: {type: 'done'},
    failed: {type: 'failed'},
  },
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

4. Validate project context and auth.

```bash
npx notionflow doctor
```

5. Execute tasks with `run` or `tick` directly from local files.

## Runtime Hooks And Shared Modules

Runtime hooks may be imported from shared modules. This is supported:

- `agent`
- `select`
- `until`

Example shared runtime helper module:

```ts
import {agent, select, until} from 'notionflow'

export const enrich = agent(async ({ctx}) => ({
  status: 'done',
  data: {...ctx, enriched: true},
}))

export const route = select(({ctx}) => (ctx.enriched ? 'finish' : 'retry'))

export const shouldStop = until(({iteration}) => iteration >= 1)
```

Factory using imported helpers:

```ts
import {defineFactory} from 'notionflow'
import {enrich, route, shouldStop} from './shared/runtime-helpers'

export default defineFactory({
  id: 'shared-helper-demo',
  start: 'run_loop',
  context: {enriched: false},
  states: {
    run_loop: {
      type: 'loop',
      body: 'enrich',
      maxIterations: 3,
      until: shouldStop,
      on: {continue: 'enrich', done: 'done', exhausted: 'failed'},
    },
    enrich: {
      type: 'action',
      agent: enrich,
      on: {done: 'route', failed: 'failed'},
    },
    route: {
      type: 'orchestrate',
      select: route,
      on: {finish: 'done', retry: 'run_loop'},
    },
    done: {type: 'done'},
    failed: {type: 'failed'},
  },
})
```

## Validation Rules

- `start` state must exist
- transition targets must exist
- action states require `on.done` and `on.failed`
- loop states require `on.continue`, `on.done`, `on.exhausted`
- loop `on.continue` must equal `body`
- declared factories in config must exist on disk
- duplicate factory IDs across declared files fail startup

## Authoring Tips

- Keep context JSON-serializable
- Keep `id` stable after tasks are in-flight
- prefer additive context writes (`data`) over destructive replacements
- use retries only for transient failures
- treat utility failures (`result.ok === false`) as explicit workflow branches

## Verification Checklist

```bash
npx notionflow doctor
npm run check
npm run lint
npm run test
npm run test:e2e
```

## Smoke Test

```bash
npx notionflow run --task <notion_page_id>
```

Or queue-driven:

```bash
npx notionflow tick --factory <factory-id>
```
