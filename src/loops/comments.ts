import { createHash } from "node:crypto";
import path from "node:path";
import { NotionClient } from "../notion/client.js";
import { loadRunState } from "../engine/context.js";
import { resumeWorkflow } from "../engine/runner.js";
import { executeAgent } from "../engine/agents.js";
import { loadWorkflow, workflowsDir } from "../workflows/dsl.js";
import { paths } from "../config/paths.js";
import {
  getOrInitRouteState,
  legacyRouteKey,
  loadCommentState,
  routeKey,
  saveCommentState
} from "./comment-state.js";

export type CommentWatcherResult = {
  scannedTasks: number;
  resumedTasks: number;
  forwardedComments: number;
  dedupedComments: number;
  escalations: number;
};

const MAX_SEEN_COMMENT_IDS = 250;
const MAX_SEEN_EVENT_FINGERPRINTS = 120;

function stateFilePath() {
  const boardId = currentBoardId();
  return process.env.COMMENT_STATE_FILE ?? path.join(paths.boardState(boardId), "comment-state.json");
}

function currentBoardId() {
  return process.env.NOTION_BOARD_ID ?? "default-board";
}

function defaultAgent() {
  return process.env.DEFAULT_AGENT ?? "openclaw";
}

function escalationThreshold() {
  const raw = Number(process.env.NEEDS_INPUT_ESCALATION_THRESHOLD ?? 3);
  if (!Number.isFinite(raw) || raw < 1) return 3;
  return Math.floor(raw);
}

function escalationCooldownMs() {
  const raw = Number(process.env.NEEDS_INPUT_ESCALATION_COOLDOWN_MS ?? 6 * 60 * 60_000);
  if (!Number.isFinite(raw) || raw < 1) return 6 * 60 * 60_000;
  return Math.floor(raw);
}

function isLikelyHumanComment(name: string) {
  const lower = (name || "").toLowerCase();
  return !lower.includes("notion") && !lower.includes("integration") && !lower.includes("bot");
}

function routeId(boardId: string, sessionKey: string, pageId: string) {
  return routeKey(boardId, sessionKey || "unknown-run", pageId);
}

function needsInputSignal(currentAction: string) {
  const value = (currentAction || "").toLowerCase();
  if (!value) return false;
  return value.includes("needs_input") || value.includes("needs input") || value.includes("awaiting") || value.includes("waiting on");
}

function fingerprint(parts: string[]) {
  return createHash("sha1").update(parts.join("\n")).digest("hex");
}

function trackBounded(list: string[], value: string, max: number) {
  if (!value) return;
  if (!list.includes(value)) list.push(value);
  if (list.length > max) list.splice(0, list.length - max);
}

function buildStructuredUnblockInput(task: { name: string; pageId: string }, stitched: string) {
  return [
    "[UNBLOCK_INPUT]",
    `task_name: ${task.name}`,
    `task_page_id: ${task.pageId}`,
    "source: notion_user_comments",
    "instructions:",
    "- Treat user comments as authoritative unblock input.",
    "- Continue implementation now.",
    "- If still blocked, ask one precise question with exact missing artifact.",
    "comments:",
    stitched
  ].join("\n");
}

function buildStructuredUnblockProgress(task: {
  name: string;
  pageId: string;
  route: string;
  currentAction: string;
  unseenCount: number;
  stitched: string;
}) {
  return [
    "- Event: `unblock_input_received`",
    `- Task: ${task.name} (${task.pageId})`,
    `- Route: ${task.route}`,
    `- Current action: ${task.currentAction || "(none)"}`,
    `- New comments forwarded: ${task.unseenCount}`,
    "- Payload:",
    "```text",
    task.stitched,
    "```"
  ].join("\n");
}

function buildEscalationMarkdown(task: {
  name: string;
  pageId: string;
  route: string;
  currentAction: string;
  needsInputConsecutive: number;
  threshold: number;
}) {
  return [
    "- Event: `needs_input_escalation`",
    `- Task: ${task.name} (${task.pageId})`,
    `- Route: ${task.route}`,
    `- Trigger: needs_input count ${task.needsInputConsecutive} >= threshold ${task.threshold}`,
    `- Current action: ${task.currentAction || "(none)"}`,
    "- Escalation policy:",
    "  - Worker must ask one specific unblock question",
    "  - Question must include expected artifact/example",
    "  - Avoid repeated generic block messages"
  ].join("\n");
}

function buildEscalationAgentMessage(task: {
  name: string;
  pageId: string;
  currentAction: string;
  needsInputConsecutive: number;
  threshold: number;
}) {
  return [
    "[UNBLOCK_ESCALATION]",
    `task_name: ${task.name}`,
    `task_page_id: ${task.pageId}`,
    `needs_input_count: ${task.needsInputConsecutive}`,
    `threshold: ${task.threshold}`,
    "instructions:",
    "- You have exceeded needs_input threshold.",
    "- Produce exactly one specific unblock request.",
    "- Include a concrete example of acceptable input.",
    "- Do not repeat prior generic wording.",
    `last_current_action: ${task.currentAction || "(none)"}`
  ].join("\n");
}

export async function runCommentWatcherOnce(client: NotionClient): Promise<CommentWatcherResult> {
  const watchTasks = await client.queryTasksForCommentWatch(100);
  const statePath = stateFilePath();
  const state = await loadCommentState(statePath);

  const boardId = currentBoardId();
  const agent = defaultAgent();
  const threshold = escalationThreshold();
  const cooldownMs = escalationCooldownMs();

  let resumedTasks = 0;
  let forwardedComments = 0;
  let dedupedComments = 0;
  let escalations = 0;

  for (const task of watchTasks) {
    const runId = task.sessionKey || "unknown-run";
    const route = routeId(boardId, runId, task.pageId);
    const routeState = getOrInitRouteState(state, route);
    const legacyState = state.routes[legacyRouteKey(task.pageId)];
    const baselineLastSeen = routeState.lastSeenCommentTime || legacyState?.lastSeenCommentTime || "";

    const comments = await client.listComments(task.pageId);
    if (comments.length === 0) {
      if (!needsInputSignal(task.currentAction)) {
        routeState.needsInputConsecutive = 0;
      }
      continue;
    }

    const unseen = comments
      .filter((c) => c.createdTime > baselineLastSeen)
      .filter((c) => c.text.length > 0)
      .filter((c) => isLikelyHumanComment(c.createdByName))
      .filter((c) => {
        if (routeState.seenCommentIds.includes(c.id)) {
          dedupedComments += 1;
          return false;
        }
        return true;
      });

    const newest = comments
      .map((c) => c.createdTime)
      .sort()
      .at(-1);
    if (newest) routeState.lastSeenCommentTime = newest;

    for (const c of comments) {
      trackBounded(routeState.seenCommentIds, c.id, MAX_SEEN_COMMENT_IDS);
    }

    const hasNeedsInput = needsInputSignal(task.currentAction);
    routeState.needsInputConsecutive = hasNeedsInput ? routeState.needsInputConsecutive + 1 : 0;

    if (unseen.length > 0) {
      const stitched = unseen
        .map((c) => `- ${c.createdByName} @ ${c.createdTime}: ${c.text}`)
        .join("\n")
        .slice(0, 4000);

      const eventId = fingerprint(["forward-comments", boardId, route, stitched]);
      if (!routeState.seenEventFingerprints.includes(eventId)) {
        await executeAgent(agent, {
          prompt: buildStructuredUnblockInput(task, stitched),
          session_id: task.sessionKey,
          timeout: 300,
        });

        const structuredProgress = buildStructuredUnblockProgress({
          name: task.name,
          pageId: task.pageId,
          route,
          currentAction: task.currentAction,
          unseenCount: unseen.length,
          stitched
        });

        await client.markTaskBuildStarted(task.pageId, "Resumed after structured user unblock input");
        await client.appendMarkdownSection(task.pageId, "User Comment Received", structuredProgress);

        trackBounded(routeState.seenEventFingerprints, eventId, MAX_SEEN_EVENT_FINGERPRINTS);
        forwardedComments += unseen.length;
        resumedTasks += 1;
        routeState.needsInputConsecutive = 0;

        const savedState = await loadRunState(task.pageId);
        if (savedState && savedState.status === "blocked") {
          const workflowId = process.env.DEFAULT_WORKFLOW_ID ?? "default-task";
          const workflowPath = path.join(workflowsDir(), `${workflowId}.yaml`);
          try {
            const workflowDef = await loadWorkflow(workflowPath);
            await resumeWorkflow(client, workflowDef, {
              pageId: task.pageId,
              taskName: task.name,
              sessionKey: task.sessionKey,
              taskContext: "",
            });
          } catch (resumeErr) {
            console.log(`[comments] workflow resume failed for ${task.pageId}: ${resumeErr}`);
          }
        }
      }
    }

    const shouldEscalate =
      hasNeedsInput &&
      routeState.needsInputConsecutive >= threshold &&
      (!routeState.lastEscalatedAt || Date.now() - Date.parse(routeState.lastEscalatedAt) >= cooldownMs);

    if (shouldEscalate) {
      const escalationId = fingerprint([
        "needs-input-escalation",
        boardId,
        route,
        String(routeState.needsInputConsecutive),
        task.currentAction || ""
      ]);

      if (!routeState.seenEventFingerprints.includes(escalationId)) {
        await executeAgent(agent, {
          prompt: buildEscalationAgentMessage({
            name: task.name,
            pageId: task.pageId,
            currentAction: task.currentAction,
            needsInputConsecutive: routeState.needsInputConsecutive,
            threshold
          }),
          session_id: task.sessionKey,
          timeout: 300,
        });

        await client.appendMarkdownSection(
          task.pageId,
          "Needs Input Escalation",
          buildEscalationMarkdown({
            name: task.name,
            pageId: task.pageId,
            route,
            currentAction: task.currentAction,
            needsInputConsecutive: routeState.needsInputConsecutive,
            threshold
          })
        );

        routeState.lastEscalatedAt = new Date().toISOString();
        routeState.escalationCount += 1;
        trackBounded(routeState.seenEventFingerprints, escalationId, MAX_SEEN_EVENT_FINGERPRINTS);
        escalations += 1;
      }
    }
  }

  await saveCommentState(statePath, state);

  return {
    scannedTasks: watchTasks.length,
    resumedTasks,
    forwardedComments,
    dedupedComments,
    escalations
  };
}
