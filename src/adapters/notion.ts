import {
  notionAppendMarkdownToPage,
  notionAppendTaskPageLog,
  notionGetPage,
  notionGetPageBodyText,
  notionPostComment,
  notionUpdateTaskPageState,
  pageTitle,
} from '../services/notion'
import type {
  BoardTaskRef,
  TaskBoardAdapter,
  TaskSnapshot,
  TaskStateUpdate,
} from '../core/taskBoardAdapter'

export function createNotionTaskBoardAdapter(token: string): TaskBoardAdapter {
  return {
    kind: 'notion',
    async getTask(ref: BoardTaskRef): Promise<TaskSnapshot> {
      const page = await notionGetPage(token, ref.externalTaskId)
      const bodyText = await notionGetPageBodyText(token, ref.externalTaskId)
      return {
        id: ref.externalTaskId,
        title: pageTitle(page),
        bodyText,
      }
    },
    async updateState(
      ref: BoardTaskRef,
      update: TaskStateUpdate,
    ): Promise<void> {
      await notionUpdateTaskPageState(
        token,
        ref.externalTaskId,
        update.state,
        update.label,
      )
    },
    async appendLog(
      ref: BoardTaskRef,
      title: string,
      detail?: string,
    ): Promise<void> {
      await notionAppendTaskPageLog(token, ref.externalTaskId, title, detail)
    },
    async appendPageContent(ref: BoardTaskRef, markdown: string): Promise<void> {
      await notionAppendMarkdownToPage(token, ref.externalTaskId, markdown)
    },
    async postComment(ref: BoardTaskRef, body: string): Promise<void> {
      await notionPostComment(token, ref.externalTaskId, body)
    },
  }
}
