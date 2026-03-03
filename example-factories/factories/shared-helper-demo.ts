import {decide, definePipe, end, flow, loop, write} from '../../src/factory/canonical'
import {
  chooseRoute,
  enrichContext,
  loopComplete,
  markFinished,
  prepareRetry,
  type SharedHelperContext,
} from './shared/runtime-helpers'

export default definePipe({
  id: 'shared-helper-demo',
  initial: {
    enriched: false,
    attempts: 0,
    finished: false,
    summary: '',
  } satisfies SharedHelperContext,
  run: flow(
    loop({
      body: flow(
        enrichContext,
        decide(chooseRoute, {
          finish: markFinished,
          retry: prepareRetry,
        }),
      ),
      until: loopComplete,
      max: 3,
      onExhausted: end.failed(
        'Shared helper demo exhausted before reaching the finish route.',
      ),
    }),
    write(ctx => ({
      markdown: [
        '# Shared Helper Demo',
        `Attempts: ${ctx.attempts}`,
        `Finished: ${ctx.finished}`,
        `Summary: ${ctx.summary}`,
      ].join('\n'),
    })),
    end.done(),
  ),
})
