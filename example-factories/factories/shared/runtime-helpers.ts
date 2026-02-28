import {agent, select, until} from 'notionflow'

type Ctx = Record<string, unknown>
type RuntimeInput = {ctx: Ctx}
type LoopInput = {iteration: number}

export const enrichContext = agent<RuntimeInput>(async ({ctx}) => ({
  status: 'done',
  data: {...ctx, enriched: true},
}))

export const chooseRoute = select<RuntimeInput>(({ctx}) =>
  ctx.enriched ? 'finish' : 'retry',
)

export const loopComplete = until<LoopInput>(({iteration}) => iteration >= 1)
