import {describe, expect, it} from 'vitest'
import {nullTaskBoardAdapter} from './taskBoardAdapter'

describe('taskBoardAdapter', () => {
  it('null adapter provides safe defaults and no-op mutations', async () => {
    const ref = {boardId: 'board-1', externalTaskId: 'task-1'}

    const snapshot = await nullTaskBoardAdapter.getTask(ref)
    expect(snapshot).toEqual({
      id: 'task-1',
      title: 'task-1',
      artifact: '',
      comments: [],
    })

    await expect(
      nullTaskBoardAdapter.updateTask(ref, {
        lifecycle: 'in_progress',
        currentAction: 'Planning',
      }),
    ).resolves.toBeUndefined()
    await expect(
      nullTaskBoardAdapter.writeArtifact(ref, '# output'),
    ).resolves.toBeUndefined()
    await expect(
      nullTaskBoardAdapter.postComment(ref, 'need feedback'),
    ).resolves.toBeUndefined()
  })
})
