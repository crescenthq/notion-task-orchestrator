import {
  ask,
  decide,
  end,
  loop,
  step,
  write,
  type AwaitFeedback,
  type Control,
  type EndSignal,
  type PipeDefinition,
  type PipeInput,
  type Step,
} from 'notionflow'

type WorkflowCtx = {
  score: number
  approved: boolean
}

const input: PipeInput<WorkflowCtx> = {
  ctx: {score: 0, approved: false},
  task: {id: 'task-1', title: 'Contract typing'},
  runId: 'run-1',
  tickId: 'tick-1',
}

const waitingSignal: AwaitFeedback<WorkflowCtx> = {
  type: 'await_feedback',
  prompt: 'Please approve this run.',
  ctx: input.ctx,
}

const doneSignal: EndSignal<WorkflowCtx> = {
  type: 'end',
  status: 'done',
  ctx: input.ctx,
}

const controlSignal: Control<WorkflowCtx> =
  input.feedback === 'yes' ? doneSignal : waitingSignal
void controlSignal

const increment = step<WorkflowCtx>('increment', ctx => ({
  ...ctx,
  score: ctx.score + 1,
}))

const assignFromProjection = step<WorkflowCtx, {nextScore: number}>(
  'project-score',
  ctx => ({nextScore: ctx.score + 1}),
  (ctx, out) => ({...ctx, score: out.nextScore}),
)

const requestApproval = ask<WorkflowCtx>(
  ctx => `Approve score ${ctx.score}?`,
  (ctx, reply) => ({
    ...ctx,
    approved: reply.trim().toLowerCase() === 'yes',
  }),
)

const boundedLoop = loop<WorkflowCtx>({
  body: increment,
  until: ctx => ctx.score >= 3,
  max: 5,
  onExhausted: end.blocked<WorkflowCtx>('Review required'),
})

const writeSummary = write<WorkflowCtx>(ctx => ({
  markdown: `score=${ctx.score}, approved=${ctx.approved}`,
}))

const branch = decide<WorkflowCtx, 'approve' | 'revise'>(
  ctx => (ctx.approved ? 'approve' : 'revise'),
  {
    approve: end.done<WorkflowCtx>('Approved'),
    revise: assignFromProjection,
  },
  {
    otherwise: end.failed<WorkflowCtx>('Unknown decision branch'),
  },
)

const run: Step<WorkflowCtx> = async currentInput => {
  let next = await requestApproval(currentInput)
  if ('type' in next) return next

  next = await boundedLoop({...currentInput, ctx: next})
  if ('type' in next) return next

  next = await writeSummary({...currentInput, ctx: next})
  if ('type' in next) return next

  return branch({...currentInput, ctx: next})
}

const pipe: PipeDefinition<WorkflowCtx> = {
  id: 'canonical-contracts',
  initial: {score: 0, approved: false},
  run,
}

void pipe.run(input)

// @ts-expect-error returning non-context output requires assign mapper
step<WorkflowCtx>('invalid-step', ctx => ({nextScore: ctx.score + 1}))

// @ts-expect-error ask parser must return context
ask<WorkflowCtx>('prompt', (_ctx, _reply) => 42)

// @ts-expect-error failed requires an explicit message
end.failed<WorkflowCtx>()
