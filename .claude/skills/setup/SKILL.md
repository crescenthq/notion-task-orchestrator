# Setup NotionFlow

You are setting up NotionFlow. Be proactive — ask for credentials, test connectivity, fix issues. All config lives in `~/.config/notionflow/`.

## Step 1: Check Prerequisites

```bash
node --version   # Must be >= 20.0.0
```

Verify `~/.config/notionflow/` exists. If not, run:
```bash
cd ~/workspace/playground/notion-task-orchestrator
bash install.sh
```

## Step 2: Configure Notion API Key

Guide the user to create a Notion integration:
1. Go to https://www.notion.so/my-integrations
2. Click "New integration"
3. Name it "NotionFlow", select the workspace
4. Copy the "Internal Integration Secret"

Save it:
```bash
npx tsx src/notionflow.ts config set notion-api-key <key>
```

## Step 3: Set Workspace Page

Ask the user for a Notion page URL where databases will be created. The page must be shared with the integration.

Extract the page ID from the URL (the 32-char hex string, add dashes to make UUID format).

```bash
npx tsx src/notionflow.ts config set workspace-page-id <page-id>
```

## Step 4: Install a Workflow

```bash
npx tsx src/notionflow.ts workflow install workflows/default-task.yaml
```

This validates the YAML, copies it to `~/.config/notionflow/workflows/`, creates a Notion database under the workspace page, and registers it as a board.

After installation, open the database in Notion and switch the view to **Board layout** grouped by **Status**. The API cannot create views — this must be done manually once.

## Step 5: Verify Agents

```bash
npx tsx src/notionflow.ts agent list
```

Each agent should show name, description, timeout, and retries. If no agents found, install them:
```bash
npx tsx src/notionflow.ts agent install agents/shell
npx tsx src/notionflow.ts agent install agents/openclaw
```

## Step 6: Dry Run

```bash
npx tsx src/notionflow.ts run <board-id> --dry-run
```

Verify the run completes without errors.

## Step 7: First Real Run

Create a test task in the Notion database:
1. Add a row with a descriptive name
2. Set Status to `queue`
3. Check `Ready to build`
4. Add task context in the page body

Run:
```bash
npx tsx src/notionflow.ts run <board-id>
```

Watch the task move through `plan` -> `build` -> `done`.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `401` from Notion API | Check API key is valid and database/page is shared with the integration |
| No tasks picked up | Verify tasks have Status=queue and Ready to build=true |
| Agent not found | Check `~/.config/notionflow/agents/`, verify agent is executable |
| Workflow validation fails | Run `notionflow workflow validate <path>` and fix errors |
