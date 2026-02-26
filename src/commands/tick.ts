import { defineCommand } from "citty";
import { syncNotionBoards } from "./notion";

export const tickCmd = defineCommand({
  meta: { name: "tick", description: "[common] Run one orchestration tick across queued tasks" },
  args: {
    board: { type: "string", required: false },
    workflow: { type: "string", required: false },
  },
  async run({ args }) {
    await syncNotionBoards({
      boardId: args.board ? String(args.board) : undefined,
      workflowId: args.workflow ? String(args.workflow) : undefined,
      runQueued: true,
    });
  },
});
