import {
  ask,
  decide,
  definePipe,
  end,
  flow,
  loop,
  step,
  write,
} from '../../src/factory/canonical'

type PrimitiveDemoContext = {
  decision: 'approve' | 'revise' | 'clarify' | ''
  draft_ready: boolean
  retry_attempts: number
  revisions: number
  summary: string
}

const startDraft = step<PrimitiveDemoContext>('start-draft', ctx => ({
  ...ctx,
  summary: 'Drafted initial plan',
  draft_ready: false,
  retry_attempts: 0,
  revisions: 0,
}))

const collectDecision = ask<PrimitiveDemoContext>(
  'Reply with approve or revise.',
  (ctx, reply) => {
    const normalized = reply.trim().toLowerCase()

    if (normalized === 'approve') {
      return {
        ...ctx,
        decision: 'approve',
      }
    }

    if (normalized === 'revise') {
      return {
        ...ctx,
        decision: 'revise',
      }
    }

    return {
      type: 'await_feedback',
      prompt: 'Please reply with "approve" or "revise".',
      ctx: {
        ...ctx,
        decision: 'clarify',
      },
    }
  },
)

const markApproved = step<PrimitiveDemoContext>('mark-approved', ctx => ({
  ...ctx,
  draft_ready: true,
  summary: 'Approved without revisions',
}))

const applyRevision = step<PrimitiveDemoContext>('apply-revision', ctx => {
  const attempts = Number(ctx.retry_attempts ?? 0)

  if (attempts === 0) {
    return {
      ...ctx,
      retry_attempts: attempts + 1,
      draft_ready: false,
      summary: 'First revision attempt failed validation, retrying once.',
    }
  }

  return {
    ...ctx,
    retry_attempts: attempts + 1,
    revisions: Number(ctx.revisions ?? 0) + 1,
    draft_ready: true,
    summary: 'Revised plan ready for publish',
  }
})

const revisionLoop = loop<PrimitiveDemoContext>({
  body: applyRevision,
  until: ctx => Boolean(ctx.draft_ready),
  max: 2,
  onExhausted: end.failed('Revision loop exhausted before draft became ready.'),
})

const publishResult = write<PrimitiveDemoContext>(ctx => ({
  markdown: [
    '# Expressive Primitive Demo',
    `Decision: ${ctx.decision || 'unknown'}`,
    `Summary: ${ctx.summary || ''}`,
    `Revisions: ${Number(ctx.revisions ?? 0)}`,
    `Retry Attempts: ${Number(ctx.retry_attempts ?? 0)}`,
  ].join('\n'),
}))

export default definePipe({
  id: 'expressive-primitives',
  initial: {
    decision: '',
    draft_ready: false,
    retry_attempts: 0,
    revisions: 0,
    summary: '',
  } satisfies PrimitiveDemoContext,
  run: flow(
    startDraft,
    collectDecision,
    decide(
      ctx => (ctx.decision === 'revise' ? 'revise' : 'publish'),
      {
        publish: flow(markApproved, publishResult, end.done()),
        revise: flow(revisionLoop, publishResult, end.done()),
      },
    ),
  ),
})
