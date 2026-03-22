import {
  notionGetPage,
  notionGetPageMarkdown,
  notionListComments,
  notionPostComment,
  notionReplacePageMarkdown,
  notionUpdateTaskPage,
  notionWhoAmI,
  pageTitle,
  richTextToPlainText,
} from '../services/notion'
import type {
  BoardTaskRef,
  TaskBoardAdapter,
  TaskBoardPatch,
  TaskSnapshot,
} from '../core/taskBoardAdapter'

function formatTaskProgress(progress: TaskBoardPatch['progress']): string | null {
  if (!progress) return null

  const parts: string[] = []
  if (progress.percent !== undefined) {
    parts.push(`${progress.percent}%`)
  }
  if (progress.label.trim().length > 0) {
    parts.push(progress.label.trim())
  }

  return parts.join(' ').trim() || null
}

function prUrlFromLinks(links: TaskBoardPatch['links']): string | null {
  if (!links) return null
  return links.find(link => link.kind === 'pr')?.url ?? null
}

function commentRole(
  comment: Awaited<ReturnType<typeof notionListComments>>[number],
  agentUserId: string | null,
): 'human' | 'agent' {
  if (agentUserId && comment.created_by?.id === agentUserId) return 'agent'
  if (comment.created_by?.type === 'bot') return 'agent'
  if (comment.display_name?.type === 'integration') return 'agent'
  return 'human'
}

export function createNotionTaskBoardAdapter(token: string): TaskBoardAdapter {
  let agentUserIdPromise: Promise<string | null> | null = null

  function getAgentUserId(): Promise<string | null> {
    agentUserIdPromise ??= notionWhoAmI(token)
      .then(user => user.id)
      .catch(() => null)
    return agentUserIdPromise
  }

  return {
    kind: 'notion',
    async getTask(ref: BoardTaskRef): Promise<TaskSnapshot> {
      const [page, artifact, comments, agentUserId] = await Promise.all([
        notionGetPage(token, ref.externalTaskId),
        notionGetPageMarkdown(token, ref.externalTaskId),
        notionListComments(token, ref.externalTaskId),
        getAgentUserId(),
      ])
      return {
        id: ref.externalTaskId,
        title: pageTitle(page),
        artifact,
        comments: comments
          .map(comment => ({
            id: comment.id,
            body: richTextToPlainText(comment.rich_text),
            createdAt: comment.created_time,
            authorId: comment.created_by?.id ?? null,
            authorName: comment.display_name?.resolved_name ?? null,
            role: commentRole(comment, agentUserId),
          }))
          .filter(comment => comment.body.length > 0),
      }
    },
    async updateTask(ref: BoardTaskRef, patch: TaskBoardPatch): Promise<void> {
      await notionUpdateTaskPage(token, ref.externalTaskId, {
        state: patch.lifecycle,
        currentAction: patch.currentAction,
        progress:
          patch.progress === undefined ? undefined : formatTaskProgress(patch.progress),
        prUrl: patch.links === undefined ? undefined : prUrlFromLinks(patch.links),
      })
    },
    async writeArtifact(ref: BoardTaskRef, markdown: string): Promise<void> {
      await notionReplacePageMarkdown(token, ref.externalTaskId, markdown)
    },
    async postComment(ref: BoardTaskRef, body: string): Promise<void> {
      await notionPostComment(token, ref.externalTaskId, body)
    },
  }
}
