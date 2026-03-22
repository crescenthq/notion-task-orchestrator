import {
  notionAppendMarkdownToPage,
  notionGetPage,
  notionGetPageBodyText,
  notionListComments,
  notionPostComment,
  notionUpdateTaskPageState,
  pageTitle,
  richTextToPlainText,
} from '../services/notion'
import type {
  BoardTaskRef,
  TaskBoardAdapter,
  TaskBoardPatch,
  TaskLifecycle,
  TaskSnapshot,
} from '../core/taskBoardAdapter'

function notionStateFromLifecycle(lifecycle: TaskLifecycle): string {
  switch (lifecycle) {
    case 'queued':
      return 'queued'
    case 'in_progress':
      return 'running'
    case 'needs_input':
      return 'feedback'
    case 'done':
      return 'done'
    case 'failed':
      return 'failed'
  }
}

export function createNotionTaskBoardAdapter(token: string): TaskBoardAdapter {
  return {
    kind: 'notion',
    async getTask(ref: BoardTaskRef): Promise<TaskSnapshot> {
      const page = await notionGetPage(token, ref.externalTaskId)
      const artifact = await notionGetPageBodyText(token, ref.externalTaskId)
      const comments = await notionListComments(token, ref.externalTaskId)
      return {
        id: ref.externalTaskId,
        title: pageTitle(page),
        artifact,
        comments: comments
          .map(comment => ({
            id: comment.id,
            body: richTextToPlainText(comment.rich_text),
            createdAt: comment.created_time,
            authorId: null,
            authorName: null,
            role: 'human' as const,
          }))
          .filter(comment => comment.body.length > 0),
      }
    },
    async updateTask(ref: BoardTaskRef, patch: TaskBoardPatch): Promise<void> {
      if (!patch.lifecycle) return
      await notionUpdateTaskPageState(
        token,
        ref.externalTaskId,
        notionStateFromLifecycle(patch.lifecycle),
        patch.currentAction,
      )
    },
    async writeArtifact(ref: BoardTaskRef, markdown: string): Promise<void> {
      await notionAppendMarkdownToPage(token, ref.externalTaskId, markdown)
    },
    async postComment(ref: BoardTaskRef, body: string): Promise<void> {
      await notionPostComment(token, ref.externalTaskId, body)
    },
  }
}
