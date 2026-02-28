---
name: setup
description:
  Guide a user through setting up NotionFlow. Use when the user asks to set up,
  install, configure, onboard, or get started with NotionFlow.
---

# NotionFlow Setup

Guided, conversational installer. Run steps automatically — only pause for user
input (Notion token, factory shape). Use AskUserQuestion for all decisions.

**Principle:** Fix what you can. Only ask when it genuinely requires user action
(creating a Notion integration, pasting a token, choosing a factory shape).

## 1. Initialize Project

```bash
npx notionflow init
```

This creates `notionflow.config.ts`, `factories/`, and `.notionflow/` in the
current directory.

If this fails, ensure Node.js ≥20 is installed.

## 2. Notion Credentials

Check for existing token:

```bash
npx notionflow doctor
```

If the doctor output shows the Notion token is missing:

1. Tell the user: "To connect to Notion, you need an integration token."
2. Direct them to https://www.notion.so/profile/integrations
3. Ask them to create a new internal integration named "NotionFlow"
4. Use AskUserQuestion: "Paste your Notion integration token (starts with ntn*
   or secret*)"
5. Save the token as an environment variable. Ask how they prefer to store it:
   - Add `NOTION_API_TOKEN=<token>` to a `.env` file in the project root
     (recommended for local dev)
   - Or export it in the shell: `export NOTION_API_TOKEN=<token>`

Validate:

```bash
npx notionflow doctor
```

Expected: `[ok] Notion auth`. If it fails, revisit the token value.

## 3. Design the Factory

**Ask first, build second.** The user should decide what they want to build
before any code is written.

Present these factory ideas with the framing: "Each state in the factory runs a
specialized inline agent function — that's what makes NotionFlow a factory, not
just a script."

Offer these examples (lead with the more novel/interesting ones):

- **PR review factory** — a planner reads the diff → a security agent scans for
  vulnerabilities → a performance agent checks bottlenecks → a summarizer writes
  the final review comment
- **Research-to-report** — a web researcher gathers sources → an analyst
  synthesizes findings → a writer drafts the report → an editor polishes it
- **Spec-to-code factory** — a product agent writes a spec from a one-liner → an
  architect designs the approach → a coder implements it → a QA agent runs tests
- **On-call triage** — a shell agent pulls logs and metrics → an analyst
  diagnoses the root cause → Claude proposes a fix → a notifier posts to Slack
- **Content repurposing** — Claude reads a long-form article → a social agent
  writes posts → a newsletter agent formats an issue → an SEO agent writes
  metadata
- **Feature development** — plan → implement → verify → summarize
- **Custom** — describe your own states and logic

Once the user picks a direction, propose a concrete state list: state IDs, what
each state does, and what kind of agent logic it needs. Confirm the state list,
then use the **add-factory** skill to create the TypeScript factory file.

## 4. Register the Factory

After the factory file is created under `factories/`, declare it in
`notionflow.config.ts`:

```ts
import {defineConfig} from 'notionflow'

export default defineConfig({
  factories: ['./factories/<factory-id>.ts'],
})
```

NotionFlow walks up parent directories to find `notionflow.config.ts`, so you
can run commands from anywhere inside the project tree.

Use `--config <path>` on any project-scoped command to override config
resolution explicitly.

## 5. Test It

Run one tick to process any queued tasks:

```bash
npx notionflow tick --factory <factory-id>
```

Watch the output. It should execute each factory state through its inline agent
function.

If you want to provision a Notion board for queue-driven workflows, run:

```bash
npx notionflow factory create --id <factory-id> --config notionflow.config.ts
```

Or provision a board for an existing factory:

```bash
npx notionflow integrations notion provision-board --board <factory-id>
```

**Important:** Tell the user they must share the database with the "NotionFlow"
integration in Notion (click "..." on the database → "Connect to" → select
"NotionFlow").

## 6. Verify

```bash
npx notionflow doctor
npx notionflow factory list
```

All should show configured resources. Setup complete.

The user can now:

- Add tasks via Notion or `npx notionflow integrations notion create-task`
- Run `npx notionflow tick` to process queued tasks
- Build more factories with the `add-factory` skill

## Troubleshooting

**`doctor` shows NOTION_API_TOKEN missing:** Ensure `NOTION_API_TOKEN` is set as
an environment variable or in a `.env` file at the project root. NotionFlow does
not read global config files.

**`tick` processes nothing:** Run `npx notionflow doctor` to confirm the project
is resolved and auth is valid. Check that at least one factory is declared in
`notionflow.config.ts`.

**Factory load error:** Check that the TypeScript file exports a valid factory
object and the path in `notionflow.config.ts` matches the file location.
Relative paths resolve from the project root (directory containing
`notionflow.config.ts`).

**Notion page not updating:** Ensure the integration is connected to the
database in Notion (Share → Connect to → NotionFlow).

**Config not found:** Run commands from inside the project directory, or pass
`--config <path>` to point to your `notionflow.config.ts` explicitly.
