import { defineCommand } from "citty";
import { openApp } from "../app/context";

export const setupCmd = defineCommand({
  meta: { name: "setup", description: "Initialize NotionFlow workspace" },
  args: {},
  async run() {
    await openApp();
    console.log("NotionFlow workspace initialized");
    console.log("");
    console.log("Next steps:");
    console.log("  executor create --id <name>   Create an executor");
    console.log("  workflow create --id <name>   Create a workflow");
    console.log("  doctor                        Check configuration");
  },
});
