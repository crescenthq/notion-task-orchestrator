import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { paths } from "./paths";

const CONFIG_FILE = path.join(paths.root, "config.json");

function readConfig(): Record<string, string> {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function writeConfig(values: Record<string, string>): void {
  const existing = readConfig();
  const merged = { ...existing, ...values };
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + "\n");
}

export function notionToken(): string | null {
  return process.env.NOTION_API_TOKEN ?? readConfig().NOTION_API_TOKEN ?? null;
}

export function notionWorkspacePageId(): string | null {
  return process.env.NOTION_WORKSPACE_PAGE_ID ?? readConfig().NOTION_WORKSPACE_PAGE_ID ?? null;
}
