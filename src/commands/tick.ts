import { defineCommand } from "citty";
import { syncNotionBoards } from "./notion";

export const tickCmd = defineCommand({
  meta: { name: "tick", description: "[common] Run one orchestration tick across queued tasks" },
  args: {
    board: { type: "string", required: false },
    factory: { type: "string", required: false },
    maxTransitionsPerTick: { type: "string", required: false, alias: "max-transitions-per-tick" },
    leaseMs: { type: "string", required: false, alias: "lease-ms" },
    leaseMode: { type: "string", required: false, alias: "lease-mode" },
    workerId: { type: "string", required: false, alias: "worker-id" },
  },
  async run({ args }) {
    const maxTransitionsPerTick = args.maxTransitionsPerTick
      ? Number.parseInt(String(args.maxTransitionsPerTick), 10)
      : undefined;
    const leaseMs = args.leaseMs ? Number.parseInt(String(args.leaseMs), 10) : undefined;
    const leaseMode = args.leaseMode === "strict" ? "strict" : "best-effort";
    await syncNotionBoards({
      boardId: args.board ? String(args.board) : undefined,
      factoryId: args.factory ? String(args.factory) : undefined,
      runQueued: true,
      maxTransitionsPerTick: Number.isFinite(maxTransitionsPerTick) ? maxTransitionsPerTick : undefined,
      leaseMs: Number.isFinite(leaseMs) ? leaseMs : undefined,
      leaseMode,
      workerId: args.workerId ? String(args.workerId) : undefined,
    });
  },
});
