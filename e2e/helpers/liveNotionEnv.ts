import {notionTasksDatabaseId, notionToken} from '../../src/config/env'

export function hasLiveNotionEnv(): boolean {
  return Boolean(notionToken() && notionTasksDatabaseId())
}

export function assertLiveNotionEnv(): void {
  if (hasLiveNotionEnv()) return

  throw new Error(
    'Live e2e execution requires `NOTION_API_TOKEN` and `NOTION_TASKS_DATABASE_ID`.',
  )
}
