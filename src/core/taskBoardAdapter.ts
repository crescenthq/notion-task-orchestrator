export type TaskLifecycle =
  | 'queued'
  | 'in_progress'
  | 'needs_input'
  | 'done'
  | 'failed'

export type TaskLinkKind = 'pr' | 'branch' | 'other'

export type TaskLink = {
  kind: TaskLinkKind
  url: string
}

export type TaskProgress = {
  label: string
  percent?: number
}

export type TaskComment = {
  id: string
  body: string
  createdAt: string
  authorId: string | null
  authorName: string | null
  role: 'human' | 'agent'
}

export type BoardTaskRef = {
  boardId: string
  externalTaskId: string
}

export type TaskSnapshot = {
  id: string
  title: string
  artifact: string
  comments: TaskComment[]
}

export type TaskBoardPatch = {
  lifecycle?: TaskLifecycle
  currentAction?: string
  progress?: TaskProgress
  links?: TaskLink[]
}

export type TaskBoardAdapter = {
  kind: string
  getTask(ref: BoardTaskRef): Promise<TaskSnapshot>
  updateTask(ref: BoardTaskRef, patch: TaskBoardPatch): Promise<void>
  writeArtifact(ref: BoardTaskRef, markdown: string): Promise<void>
  postComment(ref: BoardTaskRef, body: string): Promise<void>
}

export const nullTaskBoardAdapter: TaskBoardAdapter = {
  kind: 'null',
  getTask: async ref => ({
    id: ref.externalTaskId,
    title: ref.externalTaskId,
    artifact: '',
    comments: [],
  }),
  updateTask: async () => {},
  writeArtifact: async () => {},
  postComment: async () => {},
}
