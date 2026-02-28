import {step, type Step} from 'notionflow'

type TaskContext = {
  score: number
}

export const scoreTask: Step<TaskContext> = step('score', ctx => ({
  ...ctx,
  score: ctx.score + 1,
}))

export const chooseRoute = (ctx: TaskContext): 'done' | 'retry' => {
  return ctx.score >= 2 ? 'done' : 'retry'
}
