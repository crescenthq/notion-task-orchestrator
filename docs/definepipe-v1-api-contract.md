# definePipe v1 API Contract

This document is the reference contract for the planned hard-reset runtime and
authoring model.

For editor-native syntax highlighting, use
[`definepipe-v1-api-contract.ts`](./definepipe-v1-api-contract.ts). That file is
the source of truth for the v1 contract surface.

## Scope

- Canonical authoring API: `definePipe`, `flow`, `step`, `ask`, `loop`,
  `decide`, `write`, `end`
- Effect-native execution model
- First-class feedback suspend/resume
- Layer-based orchestration utilities

## Core Types

```ts
import {Effect, Layer} from 'effect'

export type EndStatus = 'done' | 'blocked' | 'failed'

export type PageOutput = string | {markdown: string; body?: string}

export type PipeError =
  | {code: 'validation_error'; message: string}
  | {code: 'timeout'; message: string}
  | {code: 'adapter_error'; message: string; cause?: unknown}
  | {code: 'internal_error'; message: string; cause?: unknown}

export type AwaitFeedback<C> = {
  type: 'await_feedback'
  prompt: string
  ctx: C
}

export type EndSignal<C> = {
  type: 'end'
  status: EndStatus
  ctx: C
  message?: string
}

export type Control<C> = AwaitFeedback<C> | EndSignal<C>

export type PipeInput<C> = {
  ctx: C
  feedback?: string
  task?: {id: string; title?: string; prompt?: string; context?: string}
  runId: string
  tickId: string
}
```

## Step And Pipe Contracts

```ts
export type Step<C, R = PipeServices, E = PipeError> = (
  input: PipeInput<C>,
) => Effect.Effect<C | Control<C>, E, R>

export type PipeDefinition<C, R = PipeServices> = {
  id: string
  initial: C
  run: Step<C, R>
}

export declare function definePipe<C, R = PipeServices>(
  def: PipeDefinition<C, R>,
): PipeDefinition<C, R>

export declare function flow<C, R = PipeServices, E = PipeError>(
  ...steps: readonly Step<C, R, E>[]
): Step<C, R, E>
```

## Primitive Signatures

```ts
export declare function step<C, R = PipeServices, E = PipeError>(
  name: string,
  run: (ctx: C, input: PipeInput<C>) => Effect.Effect<C, E, R> | C,
): Step<C, R, E>

export declare function step<C, O, R = PipeServices, E = PipeError>(
  name: string,
  run: (ctx: C, input: PipeInput<C>) => Effect.Effect<O, E, R> | O,
  assign: (ctx: C, out: O) => C,
): Step<C, R, E>

export type AskPrompt<C> = string | ((ctx: C) => string)

export type AskParse<C, R = never, E = PipeError> = (
  ctx: C,
  reply: string,
) => Effect.Effect<C, E, R> | C

export declare function ask<C, R = never, E = PipeError>(
  prompt: AskPrompt<C>,
  parse: AskParse<C, R, E>,
): Step<C, R, E>

export declare function decide<C, K extends string, R = PipeServices, E = PipeError>(
  select: (ctx: C) => K | Effect.Effect<K, E, R>,
  branches: Record<K, Step<C, R, E>>,
  options?: {otherwise?: Step<C, R, E>},
): Step<C, R, E>

export declare function loop<C, R = PipeServices, E = PipeError>(config: {
  body: Step<C, R, E>
  until: (ctx: C) => boolean | Effect.Effect<boolean, E, R>
  max?: number
  onExhausted?: Step<C, R, E>
}): Step<C, R, E>

export declare function write<C, R = PipeServices, E = PipeError>(
  render: (ctx: C) => PageOutput | Effect.Effect<PageOutput, E, R>,
): Step<C, R, E>

export declare const end: {
  done: <C>(message?: string) => Step<C>
  blocked: <C>(message?: string) => Step<C>
  failed: <C>(message: string) => Step<C>
}
```

## Service Layer Contracts

```ts
export type AskForRepoInput = {
  prompt: string
  timeoutMs?: number
  metadata?: Record<string, unknown>
}

export type AskForRepoOutput = {
  repo: string
  branch?: string
  metadata?: Record<string, unknown>
}

export type InvokeAgentInput = {
  prompt: string
  timeoutMs?: number
  metadata?: Record<string, unknown>
}

export type InvokeAgentOutput = {
  text: string
  metadata?: Record<string, unknown>
}

export type AgentSandboxInput = {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  metadata?: Record<string, unknown>
}

export type AgentSandboxOutput = {
  exitCode: number
  stdout: string
  stderr: string
  metadata?: Record<string, unknown>
}

export type PipeServices = {
  askForRepo: (
    input: AskForRepoInput,
  ) => Effect.Effect<AskForRepoOutput, PipeError>
  invokeAgent: (
    input: InvokeAgentInput,
  ) => Effect.Effect<InvokeAgentOutput, PipeError>
  agentSandbox: (
    input: AgentSandboxInput,
  ) => Effect.Effect<AgentSandboxOutput, PipeError>
  writePage: (output: PageOutput) => Effect.Effect<void, PipeError>
}

export type PipeAdapters = {
  askForRepo?: PipeServices['askForRepo']
  invokeAgent?: PipeServices['invokeAgent']
  agentSandbox?: PipeServices['agentSandbox']
  writePage?: PipeServices['writePage']
}

export declare function createPipeLayer(
  adapters?: PipeAdapters,
): Layer.Layer<PipeServices>
```

## Runtime Semantics

- `initial` seeds context for first run only.
- resumed runs load persisted context and do not reset to `initial`.
- `ask` emits `await_feedback` when feedback is missing.
- runtime must persist feedback prompt and context on `await_feedback`.
- `flow` sequencing is the primary authoring path; manual `Effect.andThen` is
  optional, not required.
- `pipe` should be imported from `effect`, not re-exported by `notionflow`.
