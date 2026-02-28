import {step, type Step} from '../../../src/factory/canonical'

export type SharedHelperContext = {
  enriched: boolean
  attempts: number
  finished: boolean
  summary: string
}

export const enrichContext: Step<SharedHelperContext> = step(
  'enrich-context',
  ctx => ({
    ...ctx,
    enriched: true,
    attempts: Number(ctx.attempts ?? 0) + 1,
    summary: 'Context enriched from shared helper module.',
  }),
)

export const chooseRoute = (
  ctx: SharedHelperContext,
): 'finish' | 'retry' => {
  return ctx.attempts >= 2 ? 'finish' : 'retry'
}

export const markFinished: Step<SharedHelperContext> = step(
  'mark-finished',
  ctx => ({
    ...ctx,
    finished: true,
    summary: `Finished after ${ctx.attempts} loop iteration(s).`,
  }),
)

export const prepareRetry: Step<SharedHelperContext> = step(
  'prepare-retry',
  ctx => ({
    ...ctx,
    enriched: false,
    summary: 'Retrying shared-helper loop once more.',
  }),
)

export const loopComplete = (ctx: SharedHelperContext): boolean =>
  Boolean(ctx.finished)
