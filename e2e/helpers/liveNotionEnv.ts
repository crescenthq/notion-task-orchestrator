import {notionToken} from '../../src/config/env'

export function hasLiveNotionEnv(): boolean {
  return Boolean(notionToken())
}

export function assertLiveNotionEnv(): void {
  if (hasLiveNotionEnv()) return

  throw new Error(
    'Live e2e execution requires a Notion token. Configure `NOTION_API_TOKEN` (and workspace/parent page IDs as needed).',
  )
}
