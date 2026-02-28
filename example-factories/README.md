# Example Factories

A standalone example NotionFlow project demonstrating project-local
architecture. Contains five factories and a shared helper module to show
real-world patterns.

## Included factories

- `intent` — captures and refines user intent
- `expressive-primitives` — deterministic expressive flow showcasing
  `step`, `ask`, `route`, `loop`, `retry`, `publish`, and `end`
- `magic-8` — routes a task through a Magic 8-Ball decision state
- `would-you-rather` — orchestrates a binary choice flow
- `shared-helper-demo` — demonstrates imported `agent`, `select`, and `until`
  helpers from `notionflow`

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

`NOTION_API_TOKEN` is the only variable required for `doctor` and `tick`. The
token must have access to the Notion workspace you will write tasks to.

### 3. Verify setup

```bash
npm run doctor
```

Expected output: all checks pass, factory files resolved from
`notionflow.config.ts`.

### 4. Run a factory tick

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

| Script      | Command                                                                               | Description                                          |
| ----------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `doctor`    | `tsx ../src/cli.ts doctor --config ./notionflow.config.ts`                            | Validate config and factory resolution               |
| `tick`      | `tsx ../src/cli.ts tick --config ./notionflow.config.ts`                              | Tick the next queued task across all factories       |
| `tick:demo` | `tsx ../src/cli.ts tick --factory shared-helper-demo --config ./notionflow.config.ts` | Tick next task for `shared-helper-demo` specifically |
| `check`     | `tsc --noEmit`                                                                        | Type-check all factory files                         |

## Project structure

```
example-factories/
  notionflow.config.ts        # Explicit factory declarations
  package.json                # Standalone package with runnable scripts
  factories/
    intent.ts
    expressive-primitives.ts
    magic-8.ts
    would-you-rather.ts
    shared-helper-demo.ts
    shared/
      runtime-helpers.ts      # Shared agent/select/until helpers
```

## Passing --config from any directory

Scripts in `package.json` use `--config ./notionflow.config.ts` (relative to
`example-factories/`). You can also run from anywhere using an absolute path:

```bash
npx tsx ../src/cli.ts doctor --config /path/to/example-factories/notionflow.config.ts
```
