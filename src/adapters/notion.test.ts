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
    const getPageBodySpy = vi
      .spyOn(notionService, 'notionGetPageBodyText')
      .mockResolvedValue('Body text')
    const listCommentsSpy = vi
      .spyOn(notionService, 'notionListComments')
      .mockResolvedValue([
        {
          id: 'comment-1',
          created_time: '2026-03-22T10:00:00.000Z',
          rich_text: [{plain_text: 'Need approval'}],
        },
      ])
    const pageTitleSpy = vi
      .spyOn(notionService, 'pageTitle')
      .mockReturnValue('Task title')
    const updateStateSpy = vi
      .spyOn(notionService, 'notionUpdateTaskPageState')
      .mockResolvedValue(undefined)
    const appendMarkdownSpy = vi
      .spyOn(notionService, 'notionAppendMarkdownToPage')
      .mockResolvedValue(undefined)
    const postCommentSpy = vi
      .spyOn(notionService, 'notionPostComment')
      .mockResolvedValue(undefined)

    const adapter = createNotionTaskBoardAdapter(token)

    const snapshot = await adapter.getTask(ref)
    expect(snapshot).toEqual({
      id: 'task-1',
      title: 'Task title',
      artifact: 'Body text',
      comments: [
        {
          id: 'comment-1',
          body: 'Need approval',
          createdAt: '2026-03-22T10:00:00.000Z',
          authorId: null,
          authorName: null,
          role: 'human',
        },
      ],
    })
    expect(getPageSpy).toHaveBeenCalledWith(token, 'task-1')
    expect(getPageBodySpy).toHaveBeenCalledWith(token, 'task-1')
    expect(listCommentsSpy).toHaveBeenCalledWith(token, 'task-1')
    expect(pageTitleSpy).toHaveBeenCalledWith(page)

    await adapter.updateTask(ref, {
      lifecycle: 'in_progress',
      currentAction: 'Step A',
    })
    expect(updateStateSpy).toHaveBeenCalledWith(
      token,
      'task-1',
      'running',
      'Step A',
    )

    await adapter.writeArtifact(ref, '# Demo output')
    expect(appendMarkdownSpy).toHaveBeenCalledWith(
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
