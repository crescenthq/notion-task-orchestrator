import { defineCommand } from "citty";
import { paths } from "../config/paths";
import { openApp } from "../app/context";

export const initCmd = defineCommand({
  meta: { name: "init", description: "Initialize local NotionFlow workspace" },
  async run() {
    await openApp();
    console.log(`Initialized NotionFlow at ${paths.root}`);
    console.log(`Agents dir: ${paths.agentsDir}`);
    console.log(`Workflows dir: ${paths.workflowsDir}`);
  },
});
