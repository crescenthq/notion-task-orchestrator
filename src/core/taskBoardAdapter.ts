export type TaskBoardState =
  | 'queued'
  | 'running'
  | 'feedback'
  | 'done'
  | 'blocked'
  | 'failed'

export type BoardTaskRef = {
  boardId: string
  externalTaskId: string
}

export type TaskSnapshot = {
  id: string
  title: string
  bodyText: string
}

export type TaskStateUpdate = {
  state: TaskBoardState
  label?: string
}

export type TaskBoardAdapter = {
  kind: string
  getTask(ref: BoardTaskRef): Promise<TaskSnapshot>
  updateState(ref: BoardTaskRef, update: TaskStateUpdate): Promise<void>
  appendLog(ref: BoardTaskRef, title: string, detail?: string): Promise<void>
  appendPageContent(ref: BoardTaskRef, markdown: string): Promise<void>
  postComment(ref: BoardTaskRef, body: string): Promise<void>
}

export const nullTaskBoardAdapter: TaskBoardAdapter = {
  kind: 'null',
  getTask: async ref => ({
    id: ref.externalTaskId,
    title: ref.externalTaskId,
    bodyText: '',
  }),
  updateState: async () => {},
  appendLog: async () => {},
  appendPageContent: async () => {},
  postComment: async () => {},
}
