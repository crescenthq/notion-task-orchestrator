# Example Factories (Project-Local)

This directory is a full NotionFlow project example.

## Structure

- `notionflow.config.ts`: explicit factory declarations
- `factories/`: runnable factory modules
- `factories/shared/`: shared helper modules imported by runtime hooks

Included factories:

- `intent`
- `magic-8-ball`
- `would-you-rather`
- `shared-helper-demo` (demonstrates imported `agent`/`select`/`until` helpers)

## Required Environment Variables

- `NOTION_API_TOKEN`
- `NOTION_WORKSPACE_PAGE_ID` (or pass `--parent-page` per command)

## Quick Run

From this directory:

```bash
npx notionflow doctor --config ./notionflow.config.ts
npx notionflow integrations notion provision-board --board shared-helper-demo
npx notionflow integrations notion create-task --board shared-helper-demo --factory shared-helper-demo --title "Example run" --status queue
npx notionflow tick --factory shared-helper-demo --config ./notionflow.config.ts
```

You can also run from anywhere using absolute/relative `--config`.
