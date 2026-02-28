# Architecture

NotionFlow is a project-local orchestration runtime for Notion-backed tasks.

## Local Project Layout

Each NotionFlow project defines:

- `notionflow.config.ts`
- `factories/`
- `.notionflow/`

Project root is the directory containing the resolved config file.

## Config Resolution

Commands discover project config by walking up from current working directory.

Applicable commands also support `--config <path>` for explicit resolution.

## Runtime Layers

1. CLI command layer
2. Factory execution/runtime layer
3. Project-local persistence layer
4. Notion adapter layer

## Factory Loading Model

Factories are loaded only from explicit path declarations in
`notionflow.config.ts`.

- no implicit glob scan
- relative declarations resolve from project root
- missing declaration paths fail fast
- duplicate factory IDs fail fast with conflicting path diagnostics

## Runtime Persistence

Runtime artifacts are stored under `<project-root>/.notionflow/`.

Primary artifacts:

- `notionflow.db`
- `runtime.log`
- `errors.log`

All runtime state is project-local.

## Tick Execution

`tick` defaults to one-shot execution.

With `--loop`, tick:

- repeats until signal-based shutdown
- waits 2000ms between successful cycles
- applies exponential backoff for retryable Notion API errors (`429`, transient
  `5xx`)
- handles `SIGINT`/`SIGTERM` gracefully by finishing in-flight cycle and
  stopping scheduling

## Task State Model

Operational states:

- `queued`
- `running`
- `feedback`
- `done`
- `blocked`
- `failed`

## Library-First API

Package root exports typed authoring primitives:

- `defineConfig`
- `definePipe`
- canonical primitives (`flow`, `step`, `ask`, `decide`, `loop`, `write`, `end`)

This allows reusable shared modules and deterministic factory authoring.
