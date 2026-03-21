# Example Factories

A standalone example NotionFlow project demonstrating project-local
architecture. Contains five factories and a shared helper module to show
real-world patterns.

## Included factories

- `intent` — captures and refines user intent
- `expressive-primitives` — deterministic pipe flow using `step`, `ask`,
  `decide`, `loop`, `write`, and `end`
- `magic-8` — multi-round ask/decide loop with generated answers
- `would-you-rather` — binary choice workflow with bounded input loop
- `shared-helper-demo` — shared helper composition for loop and branch logic

## Setup from a clean checkout

### 1. Install dependencies

From the repo root, install the root package first (example-factories depends on
it via `file:..`):

```bash
npm install
```

Then install example-factories dependencies:

```bash
cd example-factories
npm install
```

### 2. Set required environment variables

Create a `.env` file in `example-factories/` or export the variables in your
shell:

```bash
export NOTION_API_TOKEN=secret_...
```

`NOTION_API_TOKEN` is required for `doctor`, `notion:connect`,
`notion:create-task`, `notion:sync`, `notion:repair-task`, and `tick`. The token
must have access to the Notion workspace you will write tasks to.

### 3. Verify setup

```bash
npm run doctor
```

Expected output: all checks pass, factory files resolved from the default
top-level `pipes/` discovery.

### 4. Connect the shared board and seed a task

Connect the example project to the shared Notion board first:

```bash
npm run notion:connect -- --url "<notion-database-url>"
```

Then seed a queued task for the `shared-helper-demo` workflow.

```bash
npm run notion:create-task -- --factory shared-helper-demo --title "Run shared helper demo" --status queue
```

If a task becomes quarantined because its `Factory` property was changed in
Notion, restore the original `Factory` value and repair it explicitly:

```bash
npm run notion:repair-task -- --task "<page-id>"
```

### 5. Run a factory tick

```bash
npm run tick:demo
```

This picks up the next queued task for the `shared-helper-demo` factory and
advances it one tick.

To tick any factory by name:

```bash
npm run tick -- --factory intent
```

The expressive primitive demo can be run directly:

```bash
npm run tick -- --factory expressive-primitives
```

## Available scripts

| Script | Command | Description |
| --- | --- | --- |
| `doctor` | `tsx ../src/cli.ts doctor --config ./notionflow.config.ts` | Validate config and factory resolution |
| `notion:connect` | `tsx ../src/cli.ts integrations notion connect --config ./notionflow.config.ts` | Register the shared Notion board used by this example |
| `notion:sync` | `tsx ../src/cli.ts integrations notion sync --config ./notionflow.config.ts` | Pull tasks and feedback from the shared Notion board |
| `notion:create-task` | `tsx ../src/cli.ts integrations notion create-task --config ./notionflow.config.ts` | Create a task in the shared board for a declared factory |
| `notion:repair-task` | `tsx ../src/cli.ts integrations notion repair-task --config ./notionflow.config.ts` | Re-queue a quarantined task after restoring `Factory` |
| `tick` | `tsx ../src/cli.ts tick --config ./notionflow.config.ts` | Sync and run queued work across all factories |
| `tick:demo` | `tsx ../src/cli.ts tick --factory shared-helper-demo --config ./notionflow.config.ts` | Sync and run queued work for `shared-helper-demo` |
| `check` | `tsc --noEmit` | Type-check all factory files |

## Common command examples

```bash
npm run notion:connect -- --url "<notion-database-url>"
npm run notion:create-task -- --factory shared-helper-demo --title "Run shared helper demo" --status queue
npm run notion:sync
npm run notion:repair-task -- --task "<page-id>"
```

Use `tick` when you want to sync and immediately run queued work. Use
`notion:sync` when you want a manual sync without starting the run loop.

## Project structure

```
example-factories/
  notionflow.config.ts        # Uses default top-level pipes/ discovery
  package.json                # Standalone package with runnable scripts
  pipes/
    intent.ts
    expressive-primitives.ts
    magic-8.ts
    would-you-rather.ts
    shared-helper-demo.ts
    shared/
      runtime-helpers.ts      # Shared definePipe helper steps/selectors
```

## Passing --config from any directory

Scripts in `package.json` use `--config ./notionflow.config.ts` (relative to
`example-factories/`). You can also run from anywhere using an absolute path:

```bash
npx tsx ../src/cli.ts doctor --config /path/to/example-factories/notionflow.config.ts
```
