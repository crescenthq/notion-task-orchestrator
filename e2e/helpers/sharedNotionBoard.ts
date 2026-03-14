import {notionToken, notionWorkspacePageId} from '../../src/config/env'
import {notionCreateBoardDataSource} from '../../src/services/notion'

export async function createTemporarySharedBoard(title: string): Promise<{
  dataSourceId: string
  databaseId: string
  url: string
}> {
  const token = notionToken()
  if (!token) {
    throw new Error('NOTION_API_TOKEN is required for live shared-board tests')
  }

  const parentPageId =
    notionWorkspacePageId() ?? process.env.NOTIONFLOW_VERIFY_PARENT_PAGE_ID ?? null
  if (!parentPageId) {
    throw new Error(
      'A parent Notion page id is required to create temporary test boards. Set NOTION_WORKSPACE_PAGE_ID or NOTIONFLOW_VERIFY_PARENT_PAGE_ID.',
    )
  }

  const board = await notionCreateBoardDataSource(token, parentPageId, title)
  if (!board.url) {
    throw new Error('Temporary shared board creation did not return a Notion URL')
  }

  return {
    dataSourceId: board.dataSourceId,
    databaseId: board.databaseId,
    url: board.url,
  }
}
