# Docs Website Plan

This directory will become the root of the Starlight docs site for NotionFlow.

## Goals

- Keep the repository `README.md` as the primary landing page on GitHub.
- Use the docs website as the public destination for comprehensive project docs.
- Start with a minimal Starlight setup and defer docs drift cleanup until after the
  site is live.

## Initial Information Architecture

The first Starlight version should use a small, explicit structure:

- `src/content/docs/index.md`
- `src/content/docs/guides/factory-authoring.md`
- `src/content/docs/reference/cli-reference.md`
- `src/content/docs/reference/definepipe-v1-api-contract.md`
- `src/content/docs/reference/architecture.md`

## Initial Navigation

Use a minimal sidebar with three top-level entries/groups:

- `Home`
- `Guides`
- `Reference`

## Migration Map

Existing Markdown in this directory will move into the Starlight content
directory during the initial migration:

- `architecture.md` -> `src/content/docs/reference/architecture.md`
- `cli-reference.md` -> `src/content/docs/reference/cli-reference.md`
- `factory-authoring.md` -> `src/content/docs/guides/factory-authoring.md`
- `definepipe-v1-api-contract.md` -> `src/content/docs/reference/definepipe-v1-api-contract.md`

## Migration Rules

- Update links to their new docs-site destinations even if the linked docs are
  not present yet.
- Do not block the migration on missing or stale docs.
- Preserve existing Markdown content first; improve accuracy after the site is
  running.
- Keep source-oriented references pointing to repository paths or GitHub when
  that is the simplest option.

## Deployment

- GitHub Pages deployment is handled by `.github/workflows/deploy-docs.yml`.
- The Astro project root for deployment is `docs/`.
- GitHub repository settings must use `GitHub Actions` as the Pages source.
- The published URL is expected to be
  `https://crescenthq.github.io/notion-task-orchestrator` until a custom domain
  is configured.

## Local Development

From the repository root:

```bash
cd docs
bun install
bun run dev
```

Open `http://localhost:4321/notion-task-orchestrator` while the dev server is
running.

To verify a production build locally:

```bash
cd docs
bun run build
```
