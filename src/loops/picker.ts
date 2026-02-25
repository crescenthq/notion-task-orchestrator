import { randomUUID } from "node:crypto";
import path from "node:path";
import { NotionClient } from "../notion/client.js";
import { runWorkflow } from "../engine/runner.js";
import { loadWorkflow, workflowsDir } from "../workflows/dsl.js";

const EMPTY_CONTEXT_BLOCK_REASON =
  "Please provide a clear description of the task requirements in the page body so an agent can proceed.";

function isTaskContextInsufficient(taskContext: string) {
  const normalized = taskContext.replace(/\s+/g, " ").trim();
  return normalized.length < 80;
}

export type PickerTickResult = {
  scanned: number;
  recovered: number;
  claimed: number;
  dispatched: number;
};

function readStaleRecoveryStatuses(): string[] {
  const raw = process.env.STALE_RECOVERY_STATUSES ?? "plan,build";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s !== "queue" && s !== "done" && s !== "blocked");
}

function readStaleTimeoutMs(): number {
  const raw = Number(process.env.STALE_TASK_TIMEOUT_MS ?? 45 * 60_000);
  if (!Number.isFinite(raw) || raw <= 0) return 45 * 60_000;
  return raw;
}

export async function runPickerOnce(client: NotionClient): Promise<PickerTickResult> {
  const staleTimeoutMs = readStaleTimeoutMs();
  const staleStatuses = readStaleRecoveryStatuses();
  const staleBeforeIso = new Date(Date.now() - staleTimeoutMs).toISOString();

  let recovered = 0;
  if (staleStatuses.length > 0) {
    const staleTasks = await client.queryStaleTasksByStatuses(staleStatuses, staleBeforeIso, 20);
    for (const staleTask of staleTasks) {
      const reason = `Recovered stale task from ${staleTask.status}; re-queued by picker after inactivity.`;
      const recovery = await client.recoverStaleTaskToQueue(staleTask.pageId, staleTask.status, reason);
      if (recovery.recovered) {
        recovered += 1;
        console.log(`[picker] recovered stale ${staleTask.pageId} from ${staleTask.status}`);
      }
    }
  }

  const queue = await client.queryPickableQueueTasks(20);

  let claimed = 0;
  let dispatched = 0;

  for (const task of queue) {
    const claimToken = randomUUID();
    const now = new Date().toISOString();

    const claim = await client.claimQueueTask(task.pageId, claimToken, now);
    if (!claim.claimed) {
      console.log(
        `[picker] skip ${task.pageId} lock lost token=${claim.currentToken} status=${claim.currentStatus}`
      );
      continue;
    }

    claimed += 1;

    try {
      const taskContext = await client.getTaskContextFromPage(task.pageId);

      if (isTaskContextInsufficient(taskContext)) {
        await client.markTaskBlocked(
          task.pageId,
          EMPTY_CONTEXT_BLOCK_REASON,
          "Awaiting clear task requirements in page body"
        );
        await client.appendMarkdownSection(
          task.pageId,
          "Blocked",
          `- Reason: ${EMPTY_CONTEXT_BLOCK_REASON}`
        );
        console.log(`[picker] blocked ${task.pageId} due to insufficient task context`);
        continue;
      }

      const sessionKey = `task-${randomUUID()}`;
      await client.setSessionKey(task.pageId, sessionKey, "Worker session created; starting workflow");
      dispatched += 1;
      console.log(`[picker] dispatched ${task.pageId} -> ${sessionKey}`);

      const workflowId = process.env.DEFAULT_WORKFLOW_ID ?? "default-task";
      const workflowPath = path.join(workflowsDir(), `${workflowId}.yaml`);

      const workflowDef = await loadWorkflow(workflowPath);
      await runWorkflow(client, workflowDef, {
        pageId: task.pageId,
        taskName: task.name,
        sessionKey,
        taskContext,
      });
    } catch (err) {
      await client.markTaskBlocked(
        task.pageId,
        `workflow_failed: ${String(err).slice(0, 300)}`,
        "Workflow failed; needs attention"
      );
      await client.appendProgressSection(task.pageId, "Error", String(err));
      console.error(`[picker] workflow failed for ${task.pageId}`, err);
    }
  }

  return { scanned: queue.length, recovered, claimed, dispatched };
}
