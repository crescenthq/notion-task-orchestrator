import {
  ask,
  compileExpressiveFactory,
  end,
  loop,
  publish,
  retry,
  route,
  step,
} from '../../src/factory/expressive'
import type {ActionResult} from '../../src/factory/helpers'

type PrimitiveDemoContext = {
  decision: string
  draft_ready: boolean
  retry_attempts: number
  revisions: number
  summary: string
}

const startDraft = async (): Promise<
  ActionResult<Partial<PrimitiveDemoContext>>
> => {
  return {
    status: 'done',
    data: {
      summary: 'Drafted initial plan',
      draft_ready: false,
      retry_attempts: 0,
      revisions: 0,
    },
  }
}

const parseDecision = (
  reply: string,
): ActionResult<Partial<PrimitiveDemoContext>> => {
  const normalized = reply.trim().toLowerCase()

  if (normalized === 'approve') {
    return {
      status: 'done',
      data: {
        decision: 'approve',
        draft_ready: true,
      },
    }
  }

  if (normalized === 'revise') {
    return {
      status: 'done',
      data: {
        decision: 'revise',
        draft_ready: false,
      },
    }
  }

  return {
    status: 'feedback',
    data: {
      decision: 'clarify',
    },
  }
}

const selectDecision = ({ctx}: {ctx: PrimitiveDemoContext}): string => {
  if (ctx.decision === 'approve') return 'publish'
  if (ctx.decision === 'revise') return 'revise'
  return '__route_unmapped__'
}

const reviseDraft = async ({
  ctx,
}: {
  ctx: PrimitiveDemoContext
}): Promise<ActionResult<Partial<PrimitiveDemoContext>>> => {
  const attempts = Number(ctx.retry_attempts ?? 0)

  if (attempts === 0) {
    return {
      status: 'failed',
      message: 'Transient revision failure',
      data: {
        retry_attempts: attempts + 1,
      },
    }
  }

  return {
    status: 'done',
    data: {
      retry_attempts: attempts + 1,
      revisions: Number(ctx.revisions ?? 0) + 1,
      draft_ready: true,
      summary: 'Revised plan ready for publish',
    },
  }
}

const compiled = compileExpressiveFactory({
  id: 'expressive-primitives',
  start: 'start_draft',
  context: {
    decision: '',
    draft_ready: false,
    retry_attempts: 0,
    revisions: 0,
    summary: '',
  },
  states: {
    start_draft: step({
      run: startDraft,
      on: {
        done: 'collect_decision',
        failed: 'failed',
      },
    }),
    collect_decision: ask({
      prompt: 'Reply with approve or revise.',
      parse: parseDecision,
      on: {
        done: 'decision_route',
        failed: 'failed',
      },
    }),
    decision_route: route({
      select: selectDecision,
      on: {
        publish: 'publish_result',
        revise: 'revision_loop',
        __route_unmapped__: 'collect_decision',
      },
    }),
    revision_loop: loop({
      body: 'apply_revision',
      maxIterations: 2,
      until: ({ctx}) => Boolean(ctx.draft_ready),
      on: {
        continue: 'apply_revision',
        done: 'publish_result',
        exhausted: 'failed',
      },
    }),
    apply_revision: step({
      run: reviseDraft,
      retries: retry({
        max: 1,
        backoff: {strategy: 'fixed', ms: 0},
      }),
      on: {
        done: 'revision_loop',
        failed: 'failed',
      },
    }),
    publish_result: publish({
      render: ({ctx}) => ({
        markdown: [
          '# Expressive Primitive Demo',
          `Decision: ${ctx.decision || 'unknown'}`,
          `Summary: ${ctx.summary || ''}`,
          `Revisions: ${Number(ctx.revisions ?? 0)}`,
          `Retry Attempts: ${Number(ctx.retry_attempts ?? 0)}`,
        ].join('\n'),
      }),
      on: {
        done: 'done',
        failed: 'failed',
      },
    }),
    done: end({status: 'done'}),
    failed: end({status: 'failed'}),
  },
})

export default compiled.factory
