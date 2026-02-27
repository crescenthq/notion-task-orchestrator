import { defineCommand } from "citty";
import { syncNotionBoards } from "./notion";

export const tickCmd = defineCommand({
  meta: { name: "tick", description: "[common] Run one orchestration tick across queued tasks" },
  args: {
    board: { type: "string", required: false },
    factory: { type: "string", required: false },
  },
  async run({ args }) {
    await syncNotionBoards({
      boardId: args.board ? String(args.board) : undefined,
      factoryId: args.factory ? String(args.factory) : undefined,
      runQueued: true,
    });
  },
});
