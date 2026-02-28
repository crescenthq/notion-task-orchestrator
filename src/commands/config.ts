import { defineCommand } from "citty";
import { openApp } from "../app/context";
import { writeConfig } from "../config/env";
import { printLegacyCommandGuidance } from "./legacyGuidance";

export const configCmd = defineCommand({
  meta: { name: "config", description: "[legacy] Deprecated global config writer" },
  subCommands: {
    set: defineCommand({
      meta: { name: "set", description: "Set a config value (e.g. NOTION_API_TOKEN)" },
      args: {
        key: { type: "string", required: true, description: "Config key" },
        value: { type: "string", required: true, description: "Config value" },
      },
      async run({ args }) {
        printLegacyCommandGuidance("config set");
        await openApp();
        writeConfig({ [String(args.key)]: String(args.value) });
        console.log(`Config saved: ${args.key}`);
      },
    }),
  },
});
