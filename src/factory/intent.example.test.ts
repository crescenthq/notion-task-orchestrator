import {describe, expect, it} from 'vitest'
import type {ActionResult} from './helpers'
import intentFactory from '../../example-factories/factories/intent'

type IntentContext = Record<string, unknown>

function getAskPlanFeedbackAgent() {
  const state = intentFactory.states.ask_plan_feedback
  if (!state || state.type !== 'action') {
    throw new Error('Expected ask_plan_feedback compiled as an action state')
  }

  return state.agent as (input: {
    ctx: IntentContext
    feedback?: string
  }) => Promise<ActionResult<IntentContext>>
}

function getPlanFeedbackRouteSelector() {
  const state = intentFactory.states.plan_feedback_route
  if (!state || state.type !== 'orchestrate' || !state.select) {
    throw new Error('Expected plan_feedback_route compiled as an orchestrate state')
  }

  return {
    on: state.on,
    select: state.select as (input: {ctx: IntentContext}) => Promise<string> | string,
  }
}

function getAskReviewFeedbackAgent() {
  const state = intentFactory.states.ask_review_feedback
  if (!state || state.type !== 'action') {
    throw new Error('Expected ask_review_feedback compiled as an action state')
  }

  return state.agent as (input: {
    ctx: IntentContext
    feedback?: string
  }) => Promise<ActionResult<IntentContext>>
}

function getReviewFeedbackRouteSelector() {
  const state = intentFactory.states.review_feedback_route
  if (!state || state.type !== 'orchestrate' || !state.select) {
    throw new Error(
      'Expected review_feedback_route compiled as an orchestrate state',
    )
  }

  return {
    on: state.on,
    select: state.select as (input: {ctx: IntentContext}) => Promise<string> | string,
  }
}

function getFinalizeReportAgent() {
  const state = intentFactory.states.finalize_report
  if (!state || state.type !== 'action') {
    throw new Error('Expected finalize_report compiled as an action state')
  }

  return state.agent as (input: {
    ctx: IntentContext
    feedback?: string
  }) => Promise<ActionResult<IntentContext>>
}

describe('intent planning primitive migration', () => {
  it('compiles planning-loop stages into expressive loop/step/ask/route states', () => {
    const planLoop = intentFactory.states.plan_loop
    const draftPlan = intentFactory.states.draft_plan
    const askPlanFeedback = intentFactory.states.ask_plan_feedback
    const askPlanFeedbackPause = intentFactory.states.ask_plan_feedback__feedback
    const planFeedbackRoute = intentFactory.states.plan_feedback_route
    const revisePlan = intentFactory.states.revise_plan

    expect(planLoop?.type).toBe('loop')
    expect(draftPlan?.type).toBe('action')
    expect(askPlanFeedback?.type).toBe('action')
    expect(askPlanFeedbackPause?.type).toBe('feedback')
    expect(planFeedbackRoute?.type).toBe('orchestrate')
    expect(revisePlan?.type).toBe('action')
  })

  it('keeps plan feedback approve/revise/clarify handling through ask parsing', async () => {
    const askPlanFeedbackAgent = getAskPlanFeedbackAgent()
    const baseCtx: IntentContext = {
      plan_text: '1) Update API\n2) Add tests',
      plan_round: 1,
    }

    const approve = await askPlanFeedbackAgent({
      ctx: {...baseCtx, human_feedback: 'APPROVE PLAN'},
    })
    expect(approve.status).toBe('done')
    expect(approve.data).toEqual({
      plan_decision: 'approve',
      plan_approved: true,
      plan_feedback: 'APPROVE PLAN',
      plan_revision_notes: '',
      human_feedback: undefined,
    })

    const revise = await askPlanFeedbackAgent({
      ctx: {...baseCtx, human_feedback: 'REVISE PLAN: include rollback notes'},
    })
    expect(revise.status).toBe('done')
    expect(revise.data).toEqual({
      plan_decision: 'revise',
      plan_approved: false,
      plan_feedback: 'REVISE PLAN: include rollback notes',
      plan_revision_notes: 'include rollback notes',
      human_feedback: undefined,
    })

    const clarify = await askPlanFeedbackAgent({
      ctx: {...baseCtx, human_feedback: 'not sure yet'},
    })
    expect(clarify.status).toBe('feedback')
    expect(clarify.message).toContain('I could not classify that response')
    expect(clarify.data).toEqual({
      plan_decision: 'clarify',
      human_feedback: undefined,
    })
  })

  it('routes parsed planning decisions to approve/revise/clarify branches', async () => {
    const routeState = getPlanFeedbackRouteSelector()

    const approveEvent = await routeState.select({ctx: {plan_decision: 'approve'}})
    const reviseEvent = await routeState.select({ctx: {plan_decision: 'revise'}})
    const clarifyEvent = await routeState.select({ctx: {plan_decision: 'clarify'}})

    expect(approveEvent).toBe('approve')
    expect(reviseEvent).toBe('revise')
    expect(clarifyEvent).toBe('__route_unmapped__')
    expect(routeState.on.approve).toBe('plan_loop')
    expect(routeState.on.revise).toBe('revise_plan')
    expect(routeState.on.__route_unmapped__).toBe('ask_plan_feedback')
  })
})

describe('intent implementation/review/finalize primitive migration', () => {
  it('compiles implementation, review loop, and finalize stages to expressive primitives', () => {
    const implementWithClaude = intentFactory.states.implement_with_claude
    const reviewLoop = intentFactory.states.review_loop
    const captureReviewSummary = intentFactory.states.capture_review_summary
    const askReviewFeedback = intentFactory.states.ask_review_feedback
    const askReviewFeedbackPause =
      intentFactory.states.ask_review_feedback__feedback
    const reviewFeedbackRoute = intentFactory.states.review_feedback_route
    const reviseChanges = intentFactory.states.revise_changes
    const finalizeReport = intentFactory.states.finalize_report
    const done = intentFactory.states.done
    const blocked = intentFactory.states.blocked
    const failed = intentFactory.states.failed

    expect(implementWithClaude?.type).toBe('action')
    expect(reviewLoop?.type).toBe('loop')
    expect(captureReviewSummary?.type).toBe('action')
    expect(askReviewFeedback?.type).toBe('action')
    expect(askReviewFeedbackPause?.type).toBe('feedback')
    expect(reviewFeedbackRoute?.type).toBe('orchestrate')
    expect(reviseChanges?.type).toBe('action')
    expect(finalizeReport?.type).toBe('action')
    expect(done?.type).toBe('done')
    expect(blocked?.type).toBe('blocked')
    expect(failed?.type).toBe('failed')
  })

  it('keeps review approve/revise/clarify handling through ask parsing', async () => {
    const askReviewFeedbackAgent = getAskReviewFeedbackAgent()
    const baseCtx: IntentContext = {
      implementation_summary: 'Added API endpoint and tests',
      implementation_checks: 'npm test',
      change_summary: 'Repo path: /tmp/demo\nBranch: feat/demo',
    }

    const approve = await askReviewFeedbackAgent({
      ctx: {...baseCtx, human_feedback: 'APPROVE CHANGES'},
    })
    expect(approve.status).toBe('done')
    expect(approve.data).toEqual({
      review_decision: 'approve',
      review_approved: true,
      review_feedback: 'APPROVE CHANGES',
      review_revision_notes: '',
      human_feedback: undefined,
    })

    const revise = await askReviewFeedbackAgent({
      ctx: {
        ...baseCtx,
        human_feedback: 'REVISE CHANGES: tighten error handling',
      },
    })
    expect(revise.status).toBe('done')
    expect(revise.data).toEqual({
      review_decision: 'revise',
      review_approved: false,
      review_feedback: 'REVISE CHANGES: tighten error handling',
      review_revision_notes: 'tighten error handling',
      human_feedback: undefined,
    })

    const clarify = await askReviewFeedbackAgent({
      ctx: {...baseCtx, human_feedback: 'maybe later'},
    })
    expect(clarify.status).toBe('feedback')
    expect(clarify.message).toContain('I could not classify that response')
    expect(clarify.data).toEqual({
      review_decision: 'clarify',
      human_feedback: undefined,
    })
  })

  it('routes parsed review decisions to approve/revise/clarify branches', async () => {
    const routeState = getReviewFeedbackRouteSelector()

    const approveEvent = await routeState.select({ctx: {review_decision: 'approve'}})
    const reviseEvent = await routeState.select({ctx: {review_decision: 'revise'}})
    const clarifyEvent = await routeState.select({ctx: {review_decision: 'clarify'}})

    expect(approveEvent).toBe('approve')
    expect(reviseEvent).toBe('revise')
    expect(clarifyEvent).toBe('__route_unmapped__')
    expect(routeState.on.approve).toBe('review_loop')
    expect(routeState.on.revise).toBe('revise_changes')
    expect(routeState.on.__route_unmapped__).toBe('ask_review_feedback')
  })

  it('emits final markdown output through compiled publish state', async () => {
    const finalizeReportAgent = getFinalizeReportAgent()
    const result = await finalizeReportAgent({
      ctx: {
        repo_url: 'https://github.com/acme/demo.git',
        repo_dir: '/tmp/demo',
        repo_branch: 'feat/demo',
        feature_request: 'Add review workflow',
        plan_text: '1) Build review loop\n2) Add tests',
        implementation_summary: 'Implemented review primitives.',
        git_status_short: 'M example-factories/factories/intent.ts',
        git_diff_stat: ' intent.ts | 42 ++++++++++++++++++++++',
        review_feedback: 'APPROVE CHANGES',
      },
    })

    const markdown =
      typeof result.page === 'string' ? result.page : result.page?.markdown || ''

    expect(result.status).toBe('done')
    expect(markdown).toContain('# Intent Demo Outcome')
    expect(markdown).toContain('## Implementation Summary')
    expect(markdown).toContain('Implemented review primitives.')
    expect(markdown).toContain('## Review')
    expect(markdown).toContain('APPROVE CHANGES')
  })
})
