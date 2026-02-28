import {agent, select, until, type ActionResult} from 'notionflow'

type TaskContext = {
  score: number
}

export const scoreTask = agent(
  async ({ctx}: {ctx: TaskContext}): Promise<ActionResult<TaskContext>> => {
    return {
      status: 'done',
      data: {score: ctx.score + 1},
      message: 'score updated',
    }
  },
)

export const chooseRoute = select(({ctx}: {ctx: TaskContext}) => {
  return ctx.score >= 2 ? 'done' : 'retry'
})

export const scoreReached = until(({ctx}: {ctx: TaskContext}) => {
  return ctx.score >= 2
})
