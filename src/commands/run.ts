import { defineCommand } from "citty";
import { runFactoryTaskByExternalId } from "../core/factoryRuntime";

export async function runTaskByExternalId(taskExternalId: string): Promise<void> {
  await runFactoryTaskByExternalId(taskExternalId);
}

export const runCmd = defineCommand({
  meta: { name: "run", description: "[common] Run a factory for one task" },
  args: {
    task: { type: "string", required: true },
  },
  async run({ args }) {
    await runTaskByExternalId(String(args.task));
  },
});
