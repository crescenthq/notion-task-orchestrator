---
name: setup
description: Guide a user through setting up NotionFlow. Use when the user asks to set up, install, configure, onboard, or get started with NotionFlow.
---

# NotionFlow Setup

Guided, conversational installer. Run steps automatically — only pause for user input (Notion token, factory choices, executor selection). Use AskUserQuestion for all decisions.

**Principle:** Fix what you can. Only ask when it genuinely requires user action (creating a Notion integration, pasting a token, choosing a factory shape). Design the factory first — executors follow from the steps the user wants.

## 1. Initialize Workspace

```bash
npx notionflow setup
```

This creates `~/.config/notionflow/` with the SQLite database, agents directory, and factories directory.

If this fails, ensure Node.js ≥18 is installed and run `npm install` first.

## 2. Notion Credentials

Check for existing token:

```bash
grep -q NOTION_API_TOKEN .env 2>/dev/null && echo "HAS_TOKEN=true" || echo "HAS_TOKEN=false"
```

If `HAS_TOKEN=false`:

1. Tell the user: "To connect to Notion, you need an integration token."
2. Direct them to https://www.notion.so/profile/integrations
3. Ask them to create a new internal integration named "NotionFlow"
4. Use AskUserQuestion: "Paste your Notion integration token (starts with ntn* or secret*)"
5. Write to `.env`:
   ```bash
   echo 'NOTION_API_TOKEN=<token>' >> .env
   ```

Then use AskUserQuestion: "Do you have a specific Notion page where you want NotionFlow boards created? (paste the page ID, or 'no' to skip)"

If yes, also write `NOTION_WORKSPACE_PAGE_ID` to `.env`.

Validate:

```bash
npx notionflow doctor
```

Expected: `[ok] Notion auth`. If it fails, revisit token.

## 3. Design the Factory

**Ask first, configure second.** The user should decide what they want to build before picking any executors.

Present these factory ideas with the framing: "Each step can run a _different_ specialized agent — that's what makes NotionFlow a factory, not just a script."

Offer these examples (lead with the more novel/interesting ones):

- **PR review factory** — a planner reads the diff and writes a review brief → a security agent scans for vulnerabilities → a performance agent checks for bottlenecks → a summarizer writes the final review comment
- **Research-to-report** — a web researcher gathers sources → an analyst synthesizes findings → a writer drafts the report → an editor polishes it
- **Spec-to-code factory** — a product agent writes a spec from a one-liner → an architect designs the approach → a coder implements it → a QA agent writes and runs tests
- **On-call triage** — a shell agent pulls logs and metrics → an analyst diagnoses the root cause → Claude proposes a fix → a notifier posts to Slack
- **Content repurposing** — Claude reads a long-form article → a social agent writes Twitter/LinkedIn posts → a newsletter agent formats an issue → an SEO agent writes metadata
- **Feature development** — plan → implement → verify → summarize (classic, but still powerful)
- **Custom** — describe your own steps

Once the user picks a direction, propose a concrete step list: step IDs, what each step does, and which _type_ of agent would be best for it (e.g., "a shell script for log fetching, Claude Code for diagnosis, a webhook for notifications"). Make the agent-per-step breakdown explicit before writing any config.

Confirm the step list with the user, then use the `add-factory` skill — it handles wiring up the full multi-agent factory:

> **Always recommend `add-factory` for multi-step factories.** It's the right tool for anything with more than one step, because it lets each step use the best agent for that job.

If the user insists on a single-agent factory, create the scaffold directly:

```bash
npx notionflow workflow create --id <factory-id> --skip-notion-board
```

This creates a scaffold at `~/.config/notionflow/workflows/<factory-id>.yaml`. Each step needs:

- `id` — unique step name
- `agent` — which executor runs it (must match a registered executor ID)
- `prompt` — what the agent should do (supports `{{variables}}` for step chaining)
- Optional: `timeout`, `retries`, `on_success`, `on_fail`

Write the factory YAML based on their chosen pattern. Don't leave it as a scaffold — fill in real steps.

Verify:

```bash
npx notionflow workflow list
```

## 4. Set Up Executors (per step)

Now that the factory steps are defined, walk through each step and set up the executor it needs. Frame this as: "Each step runs on the agent best suited for that job."

For each unique `agent` value in the factory:

- Check if it's already registered:
  ```bash
  npx notionflow executor list
  ```
- If not, set it up based on the agent type:
  - **claude** → Load and run the `add-claude` skill — best for reasoning, writing, code review, diagnosis
  - **codex** → Load and run the `add-codex` skill — best for code generation and implementation
  - **openclaw** → Load and run the `add-openclaw` skill — best for targeting a specific OpenClaw agent
  - **shell** → Create inline — best for data fetching, log tailing, running tests, webhooks:
    ```bash
    npx notionflow executor create --id shell
    ```
  - **custom** → Ask for a name, create scaffold:
    ```bash
    npx notionflow executor create --id <name>
    ```
    Explain the contract: `AGENT_ACTION=describe` outputs metadata to stdout, `AGENT_ACTION=execute` reads JSON from stdin (with `prompt` and `workdir` fields), runs the work, outputs results to stdout.
    Tell the user to edit the scaffold at `~/.config/notionflow/agents/<name>`.

If a step uses the same agent type as a previous step, reuse the executor — no need to install it twice.

Verify all executors are registered:

```bash
npx notionflow executor list
```

## 5. Connect Notion Board

Provision a Notion database for the factory:

```bash
npx notionflow notion provision-board --board <factory-id>
```

This creates a Notion database with Name, Status, and Ready columns.

**Important:** Tell the user they must share the database with the "NotionFlow" integration in Notion (click "..." on the database → "Connect to" → select "NotionFlow").

If they already have an existing Notion database:

```bash
npx notionflow board add --id <factory-id> --external-id <notion_database_id>
```

## 6. Test It

Create a test task:

```bash
npx notionflow notion create-task --board <factory-id> --title "Test task" --workflow <factory-id> --status queue --ready
```

Run one tick:

```bash
npx notionflow tick
```

Watch the output. It should:

1. Sync the board and find the test task
2. Pick it up as queued + ready
3. Run each factory step through the assigned executor
4. Update the Notion page status as steps progress

## 7. Verify

```bash
npx notionflow doctor
npx notionflow board list
npx notionflow workflow list
npx notionflow executor list
```

All should show configured resources. The Notion board should show the test task with an updated status.

Setup complete. The user can now:

- Add tasks via Notion or `npx notionflow notion create-task`
- Run `npx notionflow tick` to process queued tasks
- Add more executors with add-on skills (`add-claude`, `add-codex`, `add-openclaw`)
- Build more factories with the `add-factory` skill

## Troubleshooting

**`doctor` shows NOTION_API_TOKEN missing:** Check `.env` file exists in the working directory with the token.

**`tick` finds no boards:** Run `board list`. If empty, re-run step 5.

**Executor not found during run:** The step's `agent` must match a registered executor ID. Run `executor list`.

**Notion page not updating:** Ensure the integration is connected to the database in Notion (Share → Connect to → NotionFlow).
