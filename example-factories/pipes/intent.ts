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

type IntentContext = {
  request_text: string
  repo_url: string
  feature_request: string
  plan_text: string
  plan_round: number
  implementation_summary: string
  implementation_checks: string
  review_decision: 'approve' | 'revise'
  final_status: 'done' | 'blocked'
}

const FACTORY_ID = 'intent'

function extractField(input: string, key: string): string {
  const regex = new RegExp(`${key}\\s*=\\s*([^;]+)`, 'i')
  const match = input.match(regex)
  return match?.[1]?.trim() ?? ''
}

const collectIntentBrief = ask<IntentContext>(
  [
    'Describe the request in one message.',
    'Optional format: repo=<url-or-path>; feature=<description>; decision=approve|revise',
  ].join('\n'),
  (ctx, reply) => {
    const trimmed = reply.trim()
    if (!trimmed) {
      return {
        type: 'await_feedback',
        prompt:
          'Please provide at least a short intent brief (repo/feature/decision optional).',
        ctx,
      }
    }

    const repo = extractField(trimmed, 'repo') || 'unspecified-repo'
    const feature = extractField(trimmed, 'feature') || trimmed
    const decisionInput = extractField(trimmed, 'decision').toLowerCase()
    const reviewDecision: 'approve' | 'revise' =
      decisionInput === 'revise' ? 'revise' : 'approve'

    return {
      ...ctx,
      request_text: trimmed,
      repo_url: repo,
      feature_request: feature,
      review_decision: reviewDecision,
      final_status: reviewDecision === 'revise' ? 'blocked' : 'done',
    }
  },
)

const refinePlan = loop<IntentContext>({
  body: step('refine-plan', ctx => {
    const round = Number(ctx.plan_round ?? 0) + 1
    return {
      ...ctx,
      plan_round: round,
      plan_text: [
        `Plan round ${round}`,
        `Repo: ${ctx.repo_url}`,
        `Feature: ${ctx.feature_request}`,
        '1. Add or update tests for the requested behavior.',
        '2. Implement the minimal change needed.',
        '3. Run focused verification and summarize outcomes.',
      ].join('\n'),
    }
  }),
  until: ctx => Number(ctx.plan_round ?? 0) >= 2,
  max: 3,
  onExhausted: end.failed('Plan refinement exhausted before stabilization.'),
})

const captureImplementationSummary = step<IntentContext>(
  'capture-implementation-summary',
  ctx => ({
    ...ctx,
    implementation_summary: [
      `Prepared implementation for: ${ctx.feature_request}`,
      `Repository target: ${ctx.repo_url}`,
      `Plan stabilized in ${ctx.plan_round} rounds`,
    ].join('\n'),
    implementation_checks: [
      'npm run check',
      'npm run test -- <focused suites>',
    ].join('\n'),
  }),
)

const publishSummary = write<IntentContext>(ctx => ({
  markdown: [
    '# Intent Factory Summary',
    `Factory: ${FACTORY_ID}`,
    '',
    `Request: ${ctx.request_text}`,
    `Repo: ${ctx.repo_url}`,
    '',
    'Plan:',
    ctx.plan_text,
    '',
    'Implementation summary:',
    ctx.implementation_summary,
    '',
    'Checks:',
    ctx.implementation_checks,
    '',
    `Review decision: ${ctx.review_decision}`,
  ].join('\n'),
}))

const finalizeByDecision = decide<IntentContext, 'done' | 'blocked'>(
  ctx => ctx.final_status,
  {
    done: flow(publishSummary, end.done()),
    blocked: flow(
      publishSummary,
      end.blocked('Review decision set to revise for this intent run.'),
    ),
  },
)

export default definePipe({
  id: FACTORY_ID,
  initial: {
    request_text: '',
    repo_url: '',
    feature_request: '',
    plan_text: '',
    plan_round: 0,
    implementation_summary: '',
    implementation_checks: '',
    review_decision: 'approve',
    final_status: 'done',
  } satisfies IntentContext,
  run: flow(
    collectIntentBrief,
    refinePlan,
    captureImplementationSummary,
    finalizeByDecision,
  ),
})
