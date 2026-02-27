---
name: setup
description: Guide a user through setting up NotionFlow. Use when the user asks to set up, install, configure, onboard, or get started with NotionFlow.
---

# NotionFlow Setup

Guided, conversational installer. Run steps automatically — only pause for user input (Notion token, parent page, factory shape). Use AskUserQuestion for all decisions.

**Principle:** Fix what you can. Only ask when it genuinely requires user action (creating a Notion integration, pasting a token, choosing a factory shape).

## 1. Initialize Workspace

```bash
npx notionflow setup
```

This creates `~/.config/notionflow/` with the SQLite database and factories directory.

If this fails, ensure Node.js ≥18 is installed.

## 2. Notion Credentials

Check for existing token:

```bash
npx notionflow doctor
```

If the doctor output shows the Notion token is missing:

1. Tell the user: "To connect to Notion, you need an integration token."
2. Direct them to https://www.notion.so/profile/integrations
3. Ask them to create a new internal integration named "NotionFlow"
4. Use AskUserQuestion: "Paste your Notion integration token (starts with ntn* or secret*)"
5. Save the token:
   ```bash
   npx notionflow config set NOTION_API_TOKEN <token>
   ```

Then use AskUserQuestion: "Do you have a specific Notion page where you want NotionFlow boards created? (paste the page ID, or 'no' to skip)"

If yes:
   ```bash
   npx notionflow config set NOTION_WORKSPACE_PAGE_ID <page-id>
   ```

Validate:

```bash
npx notionflow doctor
```

Expected: `[ok] Notion auth`. If it fails, revisit token.

## 3. Design the Factory

**Ask first, build second.** The user should decide what they want to build before any code is written.

Present these factory ideas with the framing: "Each state in the factory runs a specialized inline agent function — that's what makes NotionFlow a factory, not just a script."

Offer these examples (lead with the more novel/interesting ones):

- **PR review factory** — a planner reads the diff → a security agent scans for vulnerabilities → a performance agent checks bottlenecks → a summarizer writes the final review comment
- **Research-to-report** — a web researcher gathers sources → an analyst synthesizes findings → a writer drafts the report → an editor polishes it
- **Spec-to-code factory** — a product agent writes a spec from a one-liner → an architect designs the approach → a coder implements it → a QA agent runs tests
- **On-call triage** — a shell agent pulls logs and metrics → an analyst diagnoses the root cause → Claude proposes a fix → a notifier posts to Slack
- **Content repurposing** — Claude reads a long-form article → a social agent writes posts → a newsletter agent formats an issue → an SEO agent writes metadata
- **Feature development** — plan → implement → verify → summarize
- **Custom** — describe your own states and logic

Once the user picks a direction, propose a concrete state list: state IDs, what each state does, and what kind of agent logic it needs. Confirm the state list, then use the **add-factory** skill to create the TypeScript factory file.

## 4. Connect Notion Board

After the factory is installed, provision a Notion database for it:

```bash
npx notionflow integrations notion provision-board --board <factory-id>
```

**Important:** Tell the user they must share the database with the "NotionFlow" integration in Notion (click "..." on the database → "Connect to" → select "NotionFlow").

If they already have an existing Notion database:

```bash
npx notionflow board add --id <factory-id> --external-id <notion_database_id>
```

## 5. Test It

Create a test task:

```bash
npx notionflow integrations notion create-task --board <factory-id> --title "Test task" --factory <factory-id> --status queue
```

Run one tick:

```bash
npx notionflow tick
```

Watch the output. It should:

1. Sync the board and find the test task
2. Pick it up as queued
3. Execute each factory state through its inline agent function
4. Update the Notion page status as states progress

## 6. Verify

```bash
npx notionflow doctor
npx notionflow board list
npx notionflow factory list
```

All should show configured resources. The Notion board should show the test task with an updated status.

Setup complete. The user can now:

- Add tasks via Notion or `npx notionflow integrations notion create-task`
- Run `npx notionflow tick` to process queued tasks
- Build more factories with the `add-factory` skill

## Troubleshooting

**`doctor` shows NOTION_API_TOKEN missing:** Check `~/.config/notionflow/config.json` contains the token, or that `NOTION_API_TOKEN` is set as an environment variable.

**`tick` finds no boards:** Run `board list`. If empty, re-run step 4.

**Factory load error:** Check that the TypeScript file exports a valid factory object. Run `factory list` to verify it's registered.

**Notion page not updating:** Ensure the integration is connected to the database in Notion (Share → Connect to → NotionFlow).
