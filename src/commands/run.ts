import { defineCommand } from "citty";
import { runFactoryTaskByExternalId, type RuntimeRunOptions } from "../core/factoryRuntime";

export async function runTaskByExternalId(
  taskExternalId: string,
  options: RuntimeRunOptions = {},
): Promise<void> {
  await runFactoryTaskByExternalId(taskExternalId, options);
}

export const runCmd = defineCommand({
  meta: { name: "run", description: "[common] Run a factory for one task" },
  args: {
    task: { type: "string", required: true },
    config: { type: "string", required: false },
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
    const leaseMode = args.leaseMode === "best-effort" ? "best-effort" : "strict";
    await runTaskByExternalId(String(args.task), {
      configPath: args.config ? String(args.config) : undefined,
      startDir: process.cwd(),
      maxTransitionsPerTick: Number.isFinite(maxTransitionsPerTick) ? maxTransitionsPerTick : undefined,
      leaseMs: Number.isFinite(leaseMs) ? leaseMs : undefined,
      leaseMode,
      workerId: args.workerId ? String(args.workerId) : undefined,
    });
  },
});
