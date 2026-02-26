import { defineCommand } from "citty";
import { and, eq } from "drizzle-orm";
import YAML from "yaml";
import { nowIso, openApp } from "../app/context";
import { runTaskByExternalId } from "./run";
import { notionToken, notionWorkspacePageId } from "../config/env";
import { workflowSchema, workflowStepIcon } from "../core/workflow";
import { boards, tasks, workflows } from "../db/schema";
import {
  mapTaskStateToNotionStatus,
  notionCreateBoardDataSource,
  notionCreateTaskPage,
  notionEnsureBoardSchema,
  notionFindPageByTitle,
  notionGetDataSource,
  notionGetNewComments,
  notionQueryDataSource,
  pageState,
  pageTitle,
} from "../services/notion";

function localStateToDisplayStatus(state: string): string {
  return mapTaskStateToNotionStatus(localTaskStateFromNotion(state));
}

function localTaskStateFromNotion(state: string): string {
  const normalized = state.toLowerCase();
  if (normalized === "done") return "done";
  if (normalized === "failed") return "failed";
  if (normalized === "blocked") return "blocked";
  if (normalized === "in progress" || normalized === "in_progress") return "running";
  if (normalized === "waiting") return "waiting";
  if (normalized === "queue") return "queued";
  return "running"; // unknown/step labels treated as running
}

async function upsertTask(
  boardId: string,
  externalTaskId: string,
  workflowId: string,
  state: string,
): Promise<void> {
  const { db } = await openApp();
  const now = nowIso();
  await db
    .insert(tasks)
    .values({
      id: crypto.randomUUID(),
      boardId,
      externalTaskId,
      workflowId,
      state,
      currentStepId: null,
      lockToken: null,
      lockExpiresAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [tasks.boardId, tasks.externalTaskId],
      set: {
        workflowId,
        state,
        updatedAt: now,
      },
    });
}

export async function syncNotionBoards(options: {
  boardId?: string;
  workflowId?: string;
  runQueued?: boolean;
}): Promise<void> {
  const token = notionToken();
  if (!token) throw new Error("NOTION_API_TOKEN is required");

  const { db } = await openApp();
  const targetBoards = options.boardId
    ? await db.select().from(boards).where(eq(boards.id, options.boardId))
    : await db.select().from(boards);

  const notionBoards = targetBoards.filter((board) => board.adapter === "notion");
  if (notionBoards.length === 0) {
    if (options.boardId) throw new Error(`No Notion board found for: ${options.boardId}`);
    throw new Error(
      "No Notion boards registered. Use workflow install/create or integrations notion provision-board first",
    );
  }

  let totalImported = 0;
  let failedBoards = 0;
  const queuedTaskIds = new Set<string>();
  for (const board of notionBoards) {
    console.log(`Syncing board: ${board.id}`);
    let imported = 0;

    try {
      const pages = await notionQueryDataSource(token, board.externalId, 50);

      for (const page of pages) {
        const notionState = pageState(page) ?? "unknown";
        const localState = localTaskStateFromNotion(notionState);
        const workflowId = options.workflowId ?? board.id;
        await upsertTask(board.id, page.id, workflowId, localState);

        imported += 1;
        totalImported += 1;
        if (options.runQueued && localState === "queued") queuedTaskIds.add(page.id);

        if (localState === "queued") {
          console.log(`queued [${board.id}] ${page.id} ${pageTitle(page)}`);
        } else {
          console.log(`synced [${board.id}] ${page.id} ${pageTitle(page)} state=${mapTaskStateToNotionStatus(localState)}`);
        }
      }

      console.log(`Board sync complete: ${board.id} (${imported} tasks upserted)`);
    } catch (error) {
      failedBoards += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[warn] board sync failed: ${board.id} (${message})`);
    }

    // Auto-resume tasks waiting for comment feedback
    const feedbackTasks = await db.select().from(tasks)
      .where(and(eq(tasks.boardId, board.id), eq(tasks.state, "feedback")));

    for (const ft of feedbackTasks) {
      if (!ft.waitingSince) continue;
      try {
        const newComments = await notionGetNewComments(token, ft.externalTaskId, ft.waitingSince);
        if (!newComments) continue;
        const storedVars = ft.stepVarsJson ? JSON.parse(ft.stepVarsJson) as Record<string, string> : {};
        storedVars.human_feedback = newComments;
        await db.update(tasks).set({
          state: "queued",
          stepVarsJson: JSON.stringify(storedVars),
          updatedAt: nowIso(),
        }).where(and(eq(tasks.boardId, ft.boardId), eq(tasks.externalTaskId, ft.externalTaskId)));
        console.log(`[feedback] task ${ft.externalTaskId} has new comment reply → re-queued`);
        if (options.runQueued) queuedTaskIds.add(ft.externalTaskId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[warn] failed to check comments for feedback task ${ft.externalTaskId}: ${message}`);
      }
    }
  }

  console.log(`Sync complete: ${totalImported} tasks upserted across ${notionBoards.length - failedBoards}/${notionBoards.length} board(s)`);

  if (!options.runQueued || queuedTaskIds.size === 0) return;

  let runFailures = 0;
  for (const taskId of queuedTaskIds) {
    console.log(`Running queued task: ${taskId}`);
    try {
      await runTaskByExternalId(taskId);
    } catch (error) {
      runFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[warn] task run failed: ${taskId} (${message})`);
    }
  }

  const runSuccesses = queuedTaskIds.size - runFailures;
  console.log(`Run complete: ${runSuccesses}/${queuedTaskIds.size} queued task(s) succeeded`);
}

export const notionCmd = defineCommand({
  meta: { name: "notion", description: "Notion adapter commands" },
  subCommands: {
    "provision-board": defineCommand({
      meta: { name: "provision-board", description: "Create a Notion board and register it locally" },
      args: {
        board: { type: "string", required: true },
        title: { type: "string", required: false },
        parentPage: { type: "string", required: false, alias: "parent-page" },
      },
      async run({ args }) {
        const token = notionToken();
        if (!token) throw new Error("NOTION_API_TOKEN is required");

        const boardId = String(args.board);
        const providedParent = args.parentPage ? String(args.parentPage) : null;
        const parentPageId =
          providedParent ?? notionWorkspacePageId() ?? (await notionFindPageByTitle(token, "NotionFlow"));
        if (!parentPageId) {
          throw new Error("No parent page found. Set NOTION_WORKSPACE_PAGE_ID or pass --parent-page");
        }

        const title = String(args.title ?? boardId.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "));

        // Derive step-level status options from the matching workflow (board ID = workflow ID by convention)
        const { db: dbForWorkflow } = await openApp();
        const [workflowRow] = await dbForWorkflow.select().from(workflows).where(eq(workflows.id, boardId));
        const stepStatusOptions: Array<{ name: string; color: string }> = [];
        const STEP_COLORS = ["purple", "pink", "brown", "default", "blue", "green", "yellow", "orange", "red", "gray"];
        if (workflowRow) {
          const workflow = workflowSchema.parse(YAML.parse(workflowRow.definitionYaml));
          workflow.steps.forEach((step, i) => {
            const icon = workflowStepIcon(step);
            stepStatusOptions.push({
              name: icon ? `${icon} ${step.id}` : step.id,
              color: STEP_COLORS[i % STEP_COLORS.length] ?? "default",
            });
          });
        }

        const board = await notionCreateBoardDataSource(token, parentPageId, title, stepStatusOptions);
        const { db } = await openApp();
        const now = nowIso();
        await db
          .insert(boards)
          .values({
            id: boardId,
            adapter: "notion",
            externalId: board.dataSourceId,
            configJson: JSON.stringify({
              name: title,
              databaseId: board.databaseId,
              parentPageId,
              url: board.url,
            }),
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: boards.id,
            set: {
              externalId: board.dataSourceId,
              configJson: JSON.stringify({
                name: title,
                databaseId: board.databaseId,
                parentPageId,
                url: board.url,
              }),
              updatedAt: now,
            },
          });

        console.log(`Board provisioned: ${boardId} -> ${board.dataSourceId}`);
        if (board.url) console.log(`Notion URL: ${board.url}`);
      },
    }),
    "create-task": defineCommand({
      meta: { name: "create-task", description: "Create a task page in a Notion board and upsert local state" },
      args: {
        board: { type: "string", required: true },
        title: { type: "string", required: true },
        workflow: { type: "string", required: false },
        status: { type: "string", required: false },
      },
      async run({ args }) {
        const token = notionToken();
        if (!token) throw new Error("NOTION_API_TOKEN is required");

        const { db } = await openApp();
        const [board] = await db.select().from(boards).where(eq(boards.id, String(args.board)));
        if (!board) throw new Error(`Board not found: ${args.board}`);

        await notionGetDataSource(token, board.externalId);
        const state = String(args.status ?? "queue");
        const workflowId = args.workflow ? String(args.workflow) : "mixed-default";
        const page = await notionCreateTaskPage(token, board.externalId, {
          title: String(args.title),
          state: localStateToDisplayStatus(state),
        });

        await upsertTask(board.id, page.id, workflowId, localTaskStateFromNotion(state));

        console.log(`Task created: ${page.id}`);
        if (page.url) console.log(`Notion URL: ${page.url}`);
      },
    }),
    sync: defineCommand({
      meta: { name: "sync", description: "Pull tasks from Notion boards" },
      args: {
        board: { type: "string", required: false },
        workflow: { type: "string", required: false },
        run: { type: "boolean", required: false },
      },
      async run({ args }) {
        await syncNotionBoards({
          boardId: args.board ? String(args.board) : undefined,
          workflowId: args.workflow ? String(args.workflow) : undefined,
          runQueued: Boolean(args.run),
        });
      },
    }),
  },
});
