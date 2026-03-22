import {afterEach, describe, expect, it, vi} from 'vitest'
import {createNotionTaskBoardAdapter} from './notion'
import * as notionService from '../services/notion'

describe('createNotionTaskBoardAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('delegates board operations to notion service helpers', async () => {
    const token = 'token-test'
    const ref = {boardId: 'board-1', externalTaskId: 'task-1'}

    const page = {
      id: 'task-1',
      properties: {},
    } as Parameters<typeof notionService.pageTitle>[0]

    const getPageSpy = vi
      .spyOn(notionService, 'notionGetPage')
      .mockResolvedValue(page)
    const getPageMarkdownSpy = vi
      .spyOn(notionService, 'notionGetPageMarkdown')
      .mockResolvedValue('# Body text')
    const listCommentsSpy = vi
      .spyOn(notionService, 'notionListComments')
      .mockResolvedValue([
        {
          id: 'comment-1',
          created_time: '2026-03-22T10:00:00.000Z',
          created_by: {id: 'user-1'},
          display_name: {type: 'user', resolved_name: 'Reviewer'},
          rich_text: [{plain_text: 'Need approval'}],
        },
        {
          id: 'comment-2',
          created_time: '2026-03-22T10:05:00.000Z',
          created_by: {id: 'bot-1', type: 'bot'},
          display_name: {type: 'integration', resolved_name: 'Notionflow'},
          rich_text: [{plain_text: 'Working on it'}],
        },
      ])
    const whoAmISpy = vi
      .spyOn(notionService, 'notionWhoAmI')
      .mockResolvedValue({
        id: 'bot-1',
        object: 'user',
        name: 'Notionflow',
        type: 'bot',
      })
    const pageTitleSpy = vi
      .spyOn(notionService, 'pageTitle')
      .mockReturnValue('Task title')
    const updateTaskSpy = vi
      .spyOn(notionService, 'notionUpdateTaskPage')
      .mockResolvedValue(undefined)
    const replaceMarkdownSpy = vi
      .spyOn(notionService, 'notionReplacePageMarkdown')
      .mockResolvedValue(undefined)
    const postCommentSpy = vi
      .spyOn(notionService, 'notionPostComment')
      .mockResolvedValue(undefined)

    const adapter = createNotionTaskBoardAdapter(token)

    const snapshot = await adapter.getTask(ref)
    expect(snapshot).toEqual({
      id: 'task-1',
      title: 'Task title',
      artifact: '# Body text',
      comments: [
        {
          id: 'comment-1',
          body: 'Need approval',
          createdAt: '2026-03-22T10:00:00.000Z',
          authorId: 'user-1',
          authorName: 'Reviewer',
          role: 'human',
        },
        {
          id: 'comment-2',
          body: 'Working on it',
          createdAt: '2026-03-22T10:05:00.000Z',
          authorId: 'bot-1',
          authorName: 'Notionflow',
          role: 'agent',
        },
      ],
    })
    expect(getPageSpy).toHaveBeenCalledWith(token, 'task-1')
    expect(getPageMarkdownSpy).toHaveBeenCalledWith(token, 'task-1')
    expect(listCommentsSpy).toHaveBeenCalledWith(token, 'task-1')
    expect(whoAmISpy).toHaveBeenCalledWith(token)
    expect(pageTitleSpy).toHaveBeenCalledWith(page)

    await adapter.updateTask(ref, {
      lifecycle: 'in_progress',
      currentAction: 'Step A',
      progress: {label: 'Implementing', percent: 50},
      links: [
        {kind: 'branch', url: 'https://github.com/example/repo/tree/feature'},
        {kind: 'pr', url: 'https://github.com/example/repo/pull/123'},
      ],
    })
    expect(updateTaskSpy).toHaveBeenCalledWith(
      token,
      'task-1',
      {
        state: 'in_progress',
        currentAction: 'Step A',
        progress: '50% Implementing',
        prUrl: 'https://github.com/example/repo/pull/123',
      },
    )

    await adapter.writeArtifact(ref, '# Demo output')
    expect(replaceMarkdownSpy).toHaveBeenCalledWith(
      token,
      'task-1',
      '# Demo output',
    )

    await adapter.postComment(ref, 'Need approval')
    expect(postCommentSpy).toHaveBeenCalledWith(
      token,
      'task-1',
      'Need approval',
    )
  })
})
