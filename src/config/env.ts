type EnvConfig = {
  NOTION_API_TOKEN?: string
  NOTION_WORKSPACE_PAGE_ID?: string
}

export function notionToken(): string | null {
  return process.env.NOTION_API_TOKEN ?? null
}

export function notionWorkspacePageId(): string | null {
  return process.env.NOTION_WORKSPACE_PAGE_ID ?? null
}

export function getConfigFromEnv(): EnvConfig {
  return {
    NOTION_API_TOKEN: process.env.NOTION_API_TOKEN,
    NOTION_WORKSPACE_PAGE_ID: process.env.NOTION_WORKSPACE_PAGE_ID,
  }
}
