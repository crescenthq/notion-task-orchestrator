import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { NotionClient } from "./notion/client.js";
import { runPickerOnce } from "./loops/picker.js";
import { runCommentWatcherOnce } from "./loops/comments.js";
import { runWorkflow } from "./engine/runner.js";
import { loadWorkflow, workflowsDir } from "./workflows/dsl.js";
import { richTextFromPage, titleFromPage } from "./notion/types.js";

function must(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env: ${name}`);
  return val;
}

function hasFlag(name: string) {
  return process.argv.includes(name);
}

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

async function runOnce(client: NotionClient) {
  const result = await runPickerOnce(client);
  console.log(
    `[picker] once scanned=${result.scanned} recovered=${result.recovered} claimed=${result.claimed} dispatched=${result.dispatched}`
  );
}

async function runListQueue(client: NotionClient) {
  const queue = await client.queryTasksByStatus("queue", 50);
  const pickable = await client.queryPickableQueueTasks(50);
  console.log(`[queue] total=${queue.length} pickable=${pickable.length}`);
  for (const t of queue) {
    const canPick = pickable.some((p) => p.pageId === t.pageId);
    console.log(`- ${t.pageId} | ${t.name} | pickable=${canPick}`);
  }
}

async function runTaskByPage(client: NotionClient, pageId: string) {
  const page = await client.getPage(pageId);
  const sessionKey = richTextFromPage(page, "session_key") || richTextFromPage(page, "session key");
  const taskName = titleFromPage(page, "name") || `Task ${pageId}`;

  if (!sessionKey) {
    throw new Error(`Task ${pageId} has no session_key; queue-pick it first.`);
  }

  const taskContext = await client.getTaskContextFromPage(pageId);

  const workflowId = process.env.DEFAULT_WORKFLOW_ID ?? "default-task";
  const workflowPath = path.join(workflowsDir(), `${workflowId}.yaml`);
  const workflowDef = await loadWorkflow(workflowPath);
  await runWorkflow(client, workflowDef, { pageId, taskName, sessionKey, taskContext });
  console.log(`[task] workflow complete for ${pageId}`);
}

async function runCommentsOnce(client: NotionClient) {
  const result = await runCommentWatcherOnce(client);
  console.log(
    `[comments] once scanned=${result.scannedTasks} resumed=${result.resumedTasks} forwarded=${result.forwardedComments} deduped=${result.dedupedComments} escalations=${result.escalations}`
  );
}

async function main() {
  const client = new NotionClient({
    apiKey: must("NOTION_API_KEY"),
    dataSourceId: must("NOTION_DATA_SOURCE_ID")
  });

  if (hasFlag("--list-queue")) {
    await runListQueue(client);
    return;
  }

  if (hasFlag("--once")) {
    await runOnce(client);
    return;
  }

  const runTaskPageId = argValue("--run-task");
  if (runTaskPageId) {
    await runTaskByPage(client, runTaskPageId);
    return;
  }

  if (hasFlag("--comments-once")) {
    await runCommentsOnce(client);
    return;
  }

  const pickerInterval = Number(process.env.PICKER_INTERVAL_MS ?? 60_000);
  const commentInterval = Number(process.env.COMMENT_INTERVAL_MS ?? 60_000);

  console.log("[boot] notion-task-orchestrator started");

  let lastCommentRun = 0;
  while (true) {
    try {
      const result = await runPickerOnce(client);
      console.log(
        `[picker] tick scanned=${result.scanned} recovered=${result.recovered} claimed=${result.claimed} dispatched=${result.dispatched}`
      );
    } catch (err) {
      console.error("[picker] tick failed", err);
    }

    const now = Date.now();
    if (now - lastCommentRun >= commentInterval) {
      try {
        const r = await runCommentWatcherOnce(client);
        console.log(
          `[comments] tick scanned=${r.scannedTasks} resumed=${r.resumedTasks} forwarded=${r.forwardedComments} deduped=${r.dedupedComments} escalations=${r.escalations}`
        );
      } catch (err) {
        console.error("[comments] tick failed", err);
      }
      lastCommentRun = now;
    }

    await sleep(pickerInterval);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
