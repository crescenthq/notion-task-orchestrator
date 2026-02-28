import { defineCommand } from "citty";
import { notionToken } from "../config/env";
import { discoverProjectConfig } from "../project/discoverConfig";
import { notionWhoAmI } from "../services/notion";

export const doctorCmd = defineCommand({
  meta: { name: "doctor", description: "[common] Validate NotionFlow setup and integration auth" },
  async run() {
    const resolvedProject = await discoverProjectConfig(process.cwd());
    if (!resolvedProject) {
      console.error("[error] Could not find notionflow.config.ts from current directory.");
      console.error(`Start directory: ${process.cwd()}`);
      process.exitCode = 1;
      return;
    }

    console.log("[ok] Local project config resolved");
    console.log(`Project root: ${resolvedProject.projectRoot}`);
    console.log(`Config path: ${resolvedProject.configPath}`);

    const token = notionToken();
    if (!token) {
      console.log("[warn] NOTION_API_TOKEN missing");
      return;
    }

    const me = await notionWhoAmI(token);
    console.log(`[ok] Notion auth: ${me.name ?? me.id} (${me.type})`);
  },
});
