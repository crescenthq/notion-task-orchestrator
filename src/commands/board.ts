import { defineCommand } from "citty";
import { eq } from "drizzle-orm";
import { nowIso, openApp } from "../app/context";
import { boards } from "../db/schema";

export const boardCmd = defineCommand({
  meta: { name: "board", description: "Manage boards" },
  subCommands: {
    add: defineCommand({
      meta: { name: "add", description: "Add a Notion board" },
      args: {
        id: { type: "string", required: true },
        externalId: { type: "string", required: true, alias: "external-id" },
        name: { type: "string", required: false },
      },
      async run({ args }) {
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
        const { db } = await openApp();
        await db.delete(boards).where(eq(boards.id, String(args.id)));
        console.log(`Board removed: ${args.id}`);
      },
    }),
  },
});
