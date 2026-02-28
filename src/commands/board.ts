import { defineCommand } from "citty";
import { eq, inArray } from "drizzle-orm";
import { nowIso, openApp } from "../app/context";
import { boards, boardCursors, inboxEvents, runs, tasks, transitionEvents } from "../db/schema";
import { printLegacyCommandGuidance } from "./legacyGuidance";

export const boardCmd = defineCommand({
  meta: { name: "board", description: "[legacy] Deprecated board registry commands" },
  subCommands: {
    add: defineCommand({
      meta: { name: "add", description: "Add a Notion board" },
      args: {
        id: { type: "string", required: true },
        externalId: { type: "string", required: true, alias: "external-id" },
        name: { type: "string", required: false },
      },
      async run({ args }) {
        printLegacyCommandGuidance("board add");
        const { db } = await openApp();
        const timestamp = nowIso();
        await db
          .insert(boards)
          .values({
            id: String(args.id),
            adapter: "notion",
            externalId: String(args.externalId),
            configJson: JSON.stringify({ name: args.name ?? null }),
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          .onConflictDoUpdate({
            target: boards.id,
            set: {
              externalId: String(args.externalId),
              configJson: JSON.stringify({ name: args.name ?? null }),
              updatedAt: timestamp,
            },
          });

        console.log(`Board saved: ${args.id} -> ${args.externalId}`);
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List configured boards" },
      async run() {
        printLegacyCommandGuidance("board list");
        const { db } = await openApp();
        const rows = await db.select().from(boards);
        if (rows.length === 0) {
          console.log("No boards configured");
          return;
        }
        for (const row of rows) {
          const label = JSON.parse(row.configJson).name ?? "(no name)";
          console.log(`${row.id}  ${row.externalId}  ${label}`);
        }
      },
    }),
    remove: defineCommand({
      meta: { name: "remove", description: "Remove board by id" },
      args: {
        id: { type: "string", required: true },
      },
      async run({ args }) {
        printLegacyCommandGuidance("board remove");
        const { db } = await openApp();
        const boardId = String(args.id);

        const boardTasks = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.boardId, boardId));
        const taskIds = boardTasks.map((t) => t.id);

        if (taskIds.length > 0) {
          const boardRuns = await db.select({ id: runs.id }).from(runs).where(inArray(runs.taskId, taskIds));
          const runIds = boardRuns.map((r) => r.id);
          if (runIds.length > 0) {
            await db.delete(transitionEvents).where(inArray(transitionEvents.runId, runIds));
          }
          await db.delete(runs).where(inArray(runs.taskId, taskIds));
        }

        await db.delete(inboxEvents).where(eq(inboxEvents.boardId, boardId));
        await db.delete(boardCursors).where(eq(boardCursors.boardId, boardId));
        await db.delete(tasks).where(eq(tasks.boardId, boardId));
        await db.delete(boards).where(eq(boards.id, boardId));

        console.log(`Board removed: ${boardId}`);
      },
    }),
  },
});
