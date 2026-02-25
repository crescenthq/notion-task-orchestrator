#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { copyFile, chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { paths, ensureConfigDirs } from "./config/paths.js";
import { loadConfig, getConfigValue, setConfigValue, isValidConfigKey } from "./config/config.js";
import { addBoard, getBoard, loadBoardRegistry, removeBoard } from "./config/boards.js";
import { listWorkflowFiles, loadAndValidateWorkflow, loadWorkflow, workflowsDir } from "./workflows/dsl.js";
import { RunRecord, appendRunEvent, getRun, loadRunStore, upsertRun } from "./runtime/runs.js";
import { NotionClient } from "./notion/client.js";
import { runPickerOnce } from "./loops/picker.js";
import { runCommentWatcherOnce } from "./loops/comments.js";
import { listAgents, describeAgent } from "./engine/agents.js";

function arg(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return null;
  return process.argv[idx + 1] ?? null;
}

function has(name: string) {
  return process.argv.includes(name);
}

function cmdParts() {
  return process.argv.slice(2).filter((x) => !x.startsWith("--"));
}

function printUsage() {
  console.log(`notionflow CLI

Usage:
  notionflow init
  notionflow config set <key> <value>
  notionflow config get <key>

  notionflow board list [--json]
  notionflow board add --id <id> --data-source-id <id> [--name <name>] [--default-workflow <id>] [--api-key-env <ENV_VAR>]
  notionflow board remove --id <id>

  notionflow workflow list
  notionflow workflow validate <path>
  notionflow workflow install <path>

  notionflow agent list
  notionflow agent describe <name>
  notionflow agent install <path>

  notionflow run <board-id> [--task <page-id>] [--workflow <id>] [--dry-run]
  notionflow status <run-id>
  notionflow resume <run-id>
  notionflow logs [--run <run-id>]

Config keys: notion-api-key, workspace-page-id, default-agent, default-workflow
`);
}

async function handleInit() {
  await ensureConfigDirs();

  // Create default config.json if it doesn't exist
  const { loadConfig, saveConfig } = await import("./config/config.js");
  const config = await loadConfig();
  await saveConfig(config);

  // Create default boards.json if it doesn't exist
  const { loadBoardRegistry, saveBoardRegistry } = await import("./config/boards.js");
  const registry = await loadBoardRegistry();
  await saveBoardRegistry(registry);

  console.log(`Initialized ~/.config/notionflow/`);
  console.log(`  config.json`);
  console.log(`  boards.json`);
  console.log(`  workflows/`);
  console.log(`  agents/`);
  console.log(`  workflow-state/`);
  console.log(`  boards/`);
}

async function handleConfig(command: string) {
  if (command === "set") {
    const key = cmdParts()[2];
    const value = cmdParts()[3];
    if (!key || !value) throw new Error("config set requires <key> <value>");
    if (!isValidConfigKey(key)) {
      throw new Error(`Unknown config key: ${key}. Valid keys: notion-api-key, workspace-page-id, default-agent, default-workflow`);
    }
    await setConfigValue(key, value);
    console.log(`Set ${key} = ${key === "notion-api-key" ? "(hidden)" : value}`);
    return;
  }

  if (command === "get") {
    const key = cmdParts()[2];
    if (!key) throw new Error("config get requires <key>");
    if (!isValidConfigKey(key)) {
      throw new Error(`Unknown config key: ${key}. Valid keys: notion-api-key, workspace-page-id, default-agent, default-workflow`);
    }
    const value = await getConfigValue(key);
    if (value === undefined) {
      console.log(`${key}: (not set)`);
    } else {
      console.log(`${key}: ${key === "notion-api-key" ? value.slice(0, 8) + "..." : value}`);
    }
    return;
  }

  throw new Error(`Unknown config command: ${command}`);
}

async function handleBoard(command: string) {
  if (command === "list") {
    const registry = await loadBoardRegistry();
    if (has("--json")) {
      console.log(JSON.stringify(registry.boards, null, 2));
      return;
    }
    if (registry.boards.length === 0) {
      console.log("No boards configured.");
      return;
    }

    for (const board of registry.boards) {
      console.log(
        `${board.id} | dataSource=${board.notionDataSourceId} | defaultWorkflow=${board.defaultWorkflowId ?? "default-task"}`
      );
    }
    return;
  }

  if (command === "add") {
    const id = arg("--id");
    const dataSourceId = arg("--data-source-id");
    if (!id || !dataSourceId) throw new Error("board add requires --id and --data-source-id");

    await addBoard({
      id,
      name: arg("--name") ?? undefined,
      notionDataSourceId: dataSourceId,
      defaultWorkflowId: arg("--default-workflow") ?? "default-task",
      notionApiKeyEnv: arg("--api-key-env") ?? "NOTION_API_KEY"
    });

    console.log(`Board added: ${id}`);
    return;
  }

  if (command === "remove") {
    const id = arg("--id");
    if (!id) throw new Error("board remove requires --id");
    const removed = await removeBoard(id);
    if (!removed) throw new Error(`Board not found: ${id}`);
    console.log(`Board removed: ${id}`);
    return;
  }

  throw new Error(`Unknown board command: ${command}`);
}

async function handleWorkflow(command: string) {
  if (command === "list") {
    const files = await listWorkflowFiles();
    if (files.length === 0) {
      console.log("No workflows found.");
      return;
    }

    for (const file of files) {
      try {
        const { workflow, validation } = await loadAndValidateWorkflow(file);
        const status = validation.ok ? "valid" : "invalid";
        console.log(`${workflow.id} | ${status} | ${file}`);
      } catch (err) {
        console.log(`invalid | ${file} | ${String(err)}`);
      }
    }
    return;
  }

  if (command === "validate") {
    const file = cmdParts()[2];
    if (!file) throw new Error("workflow validate requires <path>");

    const { workflow, validation } = await loadAndValidateWorkflow(file);
    if (!validation.ok) {
      console.error(`Workflow invalid: ${workflow?.id ?? "unknown"}`);
      for (const e of validation.errors) console.error(`- ${e}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Workflow valid: ${workflow.id} (${workflow.steps.length} step(s))`);
    return;
  }

  if (command === "install") {
    const file = cmdParts()[2];
    if (!file) throw new Error("workflow install requires <path>");

    const { workflow, validation } = await loadAndValidateWorkflow(file);
    if (!validation.ok) {
      console.error(`Workflow invalid: ${workflow?.id ?? "unknown"}`);
      for (const e of validation.errors) console.error(`- ${e}`);
      process.exitCode = 1;
      return;
    }

    // Copy workflow to global workflows dir
    const dest = path.join(paths.workflows, path.basename(file));
    await mkdir(paths.workflows, { recursive: true });
    await copyFile(file, dest);
    console.log(`Workflow installed: ${workflow.id} -> ${dest}`);

    // Try to create Notion database if workspace page is configured
    const config = await loadConfig();
    if (config.notionApiKey && config.workspacePageId) {
      try {
        const client = new NotionClient({
          apiKey: config.notionApiKey,
          dataSourceId: "pending", // placeholder — we're creating the DB
        });
        const dbId = await client.createDatabase(config.workspacePageId, workflow.name, workflow.id);
        console.log(`Notion database created: ${dbId}`);

        // Auto-register as a board
        try {
          await addBoard({
            id: workflow.id,
            name: workflow.name,
            notionDataSourceId: dbId,
            defaultWorkflowId: workflow.id,
          });
          console.log(`Board registered: ${workflow.id}`);
        console.log(`Tip: In Notion, switch the database view to Board layout and group by Status for best experience.`);
        } catch (err: any) {
          if (err?.message?.includes("already exists")) {
            console.log(`Board ${workflow.id} already registered.`);
          } else {
            throw err;
          }
        }
      } catch (err) {
        console.log(`Note: Could not auto-create Notion database: ${err}`);
        console.log(`You can create the database manually and register it with: notionflow board add --id ${workflow.id} --data-source-id <db-id>`);
      }
    } else {
      console.log(`Tip: Set workspace-page-id and notion-api-key to auto-create Notion databases on install.`);
      console.log(`Tip: In Notion, switch the database view to Board layout and group by Status for best experience.`);
    }

    return;
  }

  throw new Error(`Unknown workflow command: ${command}`);
}

async function handleAgent(command: string) {
  if (command === "list") {
    const agents = await listAgents();
    if (agents.length === 0) {
      console.log("No agents found.");
      return;
    }

    for (const name of agents) {
      try {
        const meta = await describeAgent(name);
        console.log(`${meta.name} | ${meta.description} | timeout=${meta.timeout} retries=${meta.retries}`);
      } catch {
        console.log(`${name} | (describe failed)`);
      }
    }
    return;
  }

  if (command === "describe") {
    const name = cmdParts()[2];
    if (!name) throw new Error("agent describe requires <name>");

    const meta = await describeAgent(name);
    console.log(`name: ${meta.name}`);
    console.log(`description: ${meta.description}`);
    console.log(`timeout: ${meta.timeout}`);
    console.log(`retries: ${meta.retries}`);
    return;
  }

  if (command === "install") {
    const file = cmdParts()[2];
    if (!file) throw new Error("agent install requires <path>");

    const agentName = path.basename(file);
    const dest = path.join(paths.agents, agentName);
    await mkdir(paths.agents, { recursive: true });
    await copyFile(file, dest);
    await chmod(dest, 0o755);

    // Verify agent responds to describe
    try {
      const meta = await describeAgent(agentName);
      console.log(`Agent installed: ${meta.name} (${meta.description})`);
    } catch (err) {
      console.log(`Agent copied to ${dest} but describe failed: ${err}`);
      console.log(`The agent may still work — verify manually with: notionflow agent describe ${agentName}`);
    }

    return;
  }

  throw new Error(`Unknown agent command: ${command}`);
}

function nowIso() {
  return new Date().toISOString();
}

async function handleRun() {
  const boardId = cmdParts()[1];
  if (!boardId) throw new Error("run requires <board-id>");
  const board = await getBoard(boardId);
  if (!board) throw new Error(`Board not found: ${boardId}`);

  const runId = `run-${randomUUID().slice(0, 8)}`;
  const workflowId = arg("--workflow") ?? board.defaultWorkflowId ?? "default-task";
  const dryRun = has("--dry-run");
  const taskPageId = arg("--task") ?? undefined;

  const run: RunRecord = {
    runId,
    boardId,
    workflowId,
    taskPageId,
    status: dryRun ? "dry_run" : "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    events: []
  };

  await upsertRun(run);
  await appendRunEvent(runId, `Run created for board=${boardId} workflow=${workflowId}`);
  if (taskPageId) await appendRunEvent(runId, `Pinned to taskPageId=${taskPageId}`);

  if (dryRun) {
    await appendRunEvent(runId, "Dry run requested; no Notion/agent side effects executed.");
    console.log(`Run created: ${runId} status=${run.status}`);
    return;
  }

  // Resolve API key: first from global config, then from env var
  const config = await loadConfig();
  const apiKeyEnv = board.notionApiKeyEnv ?? "NOTION_API_KEY";
  const apiKey = config.notionApiKey || process.env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Missing API key. Set via: notionflow config set notion-api-key <key> or env var ${apiKeyEnv}`);
  }

  process.env.NOTION_API_KEY = apiKey;
  process.env.NOTION_DATA_SOURCE_ID = board.notionDataSourceId;
  process.env.NOTION_BOARD_ID = board.id;
  process.env.COMMENT_STATE_FILE = path.join(paths.boardState(board.id), "comment-state.json");

  const client = new NotionClient({
    apiKey,
    dataSourceId: board.notionDataSourceId
  });

  const picker = await runPickerOnce(client);
  const comments = await runCommentWatcherOnce(client);

  const completed: RunRecord = {
    ...run,
    status: "done",
    updatedAt: nowIso()
  };
  await upsertRun(completed);
  await appendRunEvent(
    runId,
    `Executed board tick: picker(scanned=${picker.scanned},claimed=${picker.claimed},dispatched=${picker.dispatched}) comments(scanned=${comments.scannedTasks},resumed=${comments.resumedTasks},forwarded=${comments.forwardedComments},deduped=${comments.dedupedComments},escalations=${comments.escalations})`
  );

  console.log(`Run complete: ${runId} status=done`);
}

async function handleStatus() {
  const runId = cmdParts()[1];
  if (!runId) throw new Error("status requires <run-id>");

  const run = await getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  if (has("--json")) {
    console.log(JSON.stringify(run, null, 2));
    return;
  }

  console.log(`run=${run.runId}`);
  console.log(`board=${run.boardId}`);
  console.log(`workflow=${run.workflowId}`);
  console.log(`status=${run.status}`);
  console.log(`updatedAt=${run.updatedAt}`);
}

async function handleResume() {
  const runId = cmdParts()[1];
  if (!runId) throw new Error("resume requires <run-id>");

  const run = await getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  const resumed: RunRecord = {
    ...run,
    status: "queued",
    updatedAt: nowIso()
  };
  await upsertRun(resumed);
  await appendRunEvent(runId, "Run resumed and set to queued.");

  console.log(`Run resumed: ${runId}`);
}

async function handleLogs() {
  const runId = arg("--run");
  if (runId) {
    const run = await getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    console.log(`Logs for ${run.runId}`);
    for (const evt of run.events) console.log(`${evt.at} | ${evt.message}`);
    return;
  }

  const store = await loadRunStore();
  if (store.runs.length === 0) {
    console.log("No runs found.");
    return;
  }

  for (const run of store.runs.slice(0, 20)) {
    console.log(`${run.runId} | ${run.boardId} | ${run.workflowId} | ${run.status} | events=${run.events.length}`);
  }
}

async function main() {
  const [group, command] = cmdParts();
  if (!group) {
    printUsage();
    return;
  }

  if (group === "init") return handleInit();
  if (group === "config") return handleConfig(command ?? "");
  if (group === "board") return handleBoard(command ?? "");
  if (group === "workflow") return handleWorkflow(command ?? "");
  if (group === "agent") return handleAgent(command ?? "");
  if (group === "run") return handleRun();
  if (group === "status") return handleStatus();
  if (group === "resume") return handleResume();
  if (group === "logs") return handleLogs();

  if (["--help", "help", "-h"].includes(group)) {
    printUsage();
    return;
  }

  throw new Error(`Unknown command group: ${group}`);
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
