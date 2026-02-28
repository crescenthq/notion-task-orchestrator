import { defineCommand } from "citty";
import { notionToken } from "../config/env";
import { ProjectConfigResolutionError, resolveProjectConfig } from "../project/discoverConfig";
import { notionWhoAmI } from "../services/notion";

export const doctorCmd = defineCommand({
  meta: { name: "doctor", description: "[common] Validate NotionFlow setup and integration auth" },
  args: {
    config: { type: "string", required: false },
  },
  async run({ args }) {
    let resolvedProject;
    try {
      resolvedProject = await resolveProjectConfig({
        startDir: process.cwd(),
        configPath: args.config ? String(args.config) : undefined,
      });
    } catch (error) {
      if (!(error instanceof ProjectConfigResolutionError)) {
        throw error;
      }

      console.error(`[error] ${error.message}`);
      console.error(`Start directory: ${error.startDir}`);
      if (error.attemptedPath) {
        console.error(`Attempted config path: ${error.attemptedPath}`);
      }
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
