import { defineCommand } from "citty";
import { openApp } from "../app/context";
import { printLegacyCommandGuidance } from "./legacyGuidance";

export const setupCmd = defineCommand({
  meta: { name: "setup", description: "[legacy] Deprecated setup shim" },
  args: {},
  async run() {
    printLegacyCommandGuidance("setup");
    await openApp();
    console.log("NotionFlow workspace is ready");
  },
});
