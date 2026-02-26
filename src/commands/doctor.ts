import { defineCommand } from "citty";
import { openApp } from "../app/context";
import { notionToken } from "../config/env";
import { notionWhoAmI } from "../services/notion";

export const doctorCmd = defineCommand({
  meta: { name: "doctor", description: "[common] Validate NotionFlow setup and integration auth" },
  async run() {
    await openApp();
    console.log("[ok] Local workspace ready");

    const token = notionToken();
    if (!token) {
      console.log("[warn] NOTION_API_TOKEN missing");
      return;
    }

    const me = await notionWhoAmI(token);
    console.log(`[ok] Notion auth: ${me.name ?? me.id} (${me.type})`);
  },
});
