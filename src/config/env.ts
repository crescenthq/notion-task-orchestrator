type EnvConfig = {
  NOTION_API_TOKEN?: string
  NOTION_TASKS_DATABASE_ID?: string
}

export function notionToken(): string | null {
  return process.env.NOTION_API_TOKEN ?? null
}

export function notionTasksDatabaseId(): string | null {
  return process.env.NOTION_TASKS_DATABASE_ID ?? null
}

export function getConfigFromEnv(): EnvConfig {
  return {
    NOTION_API_TOKEN: process.env.NOTION_API_TOKEN,
    NOTION_TASKS_DATABASE_ID: process.env.NOTION_TASKS_DATABASE_ID,
  }
}
