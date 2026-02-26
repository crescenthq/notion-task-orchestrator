import dotenv from "dotenv";

dotenv.config();

export function notionToken(): string | null {
  return process.env.NOTION_API_TOKEN ?? null;
}

export function notionWorkspacePageId(): string | null {
  return process.env.NOTION_WORKSPACE_PAGE_ID ?? null;
}
