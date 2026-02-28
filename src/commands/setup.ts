import { defineCommand } from "citty";
import { openApp } from "../app/context";

export const setupCmd = defineCommand({
  meta: { name: "setup", description: "[common] Set up local NotionFlow workspace" },
  args: {},
  async run() {
    await openApp();
    console.log("NotionFlow workspace is ready");
    console.log("");
    console.log("Next steps:");
    console.log("  notionflow doctor                         Check configuration");
    console.log("  notionflow factory create --id <name>    Create a factory");
    console.log("  notionflow factory list                  List available factories");
  },
});
