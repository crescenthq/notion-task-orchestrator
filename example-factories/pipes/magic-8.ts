import {
  ask,
  decide,
  definePipe,
  end,
  flow,
  step,
  write,
} from '../../src/factory/canonical'

type RoundSummary = {
  question: string
  answer: string
}

type Magic8Phase = 'await_question' | 'await_replay' | 'complete'

type Magic8Context = {
  phase: Magic8Phase
  round: number
  question: string
  last_answer: string
  history: RoundSummary[]
}

const RESPONSES = [
  'Signs point to yes.',
  'Outlook not so good.',
  'Ask again later.',
  'Without a doubt.',
  'Better not tell you now.',
]

const chooseAnswer = (question: string, round: number): string => {
  const seed = question.length + round
  return RESPONSES[Math.abs(seed) % RESPONSES.length] ?? 'Reply hazy, try again.'
}

const conversationStep = ask<Magic8Context>(
  ctx => {
    if (ctx.phase === 'await_replay') {
      return `Magic 8-Ball: ${ctx.last_answer}\n\nAsk another? (yes/no)`
    }

    return `Magic 8-Ball round ${ctx.round + 1}: Ask a yes/no question.`
  },
  (ctx, reply) => {
    if (ctx.phase === 'await_question') {
      const question = reply.trim()
      const round = Number(ctx.round ?? 0) + 1
      const answer = chooseAnswer(question, round)
      return {
        type: 'await_feedback',
        prompt: `Magic 8-Ball: ${answer}\n\nAsk another? (yes/no)`,
        ctx: {
          ...ctx,
          phase: 'await_replay',
          round,
          question,
          last_answer: answer,
          history: [...ctx.history, {question, answer}],
        },
      }
    }

    if (ctx.phase === 'await_replay') {
      const normalized = reply.trim().toLowerCase()
      if (normalized.startsWith('y')) {
        return {
          type: 'await_feedback',
          prompt: `Magic 8-Ball round ${ctx.round + 1}: Ask a yes/no question.`,
          ctx: {
            ...ctx,
            phase: 'await_question',
            question: '',
            last_answer: '',
          },
        }
      }

      if (normalized.startsWith('n')) {
        return {
          ...ctx,
          phase: 'complete',
        }
      }

      return {
        type: 'await_feedback',
        prompt: 'Please reply with yes or no. Ask another question?',
        ctx,
      }
    }

    return ctx
  },
)

const ensureCompletion = decide<Magic8Context, 'complete' | 'incomplete'>(
  ctx => (ctx.phase === 'complete' ? 'complete' : 'incomplete'),
  {
    complete: flow(
      write(ctx => ({
        markdown: [
          '# Magic 8-Ball',
          ...ctx.history.map(
            (entry, index) =>
              `${index + 1}. Q: ${entry.question}\n   A: ${entry.answer}`,
          ),
        ].join('\n'),
      })),
      end.done(),
    ),
    incomplete: flow(
      step('mark-incomplete', ctx => ctx),
      end.failed('Magic 8-Ball conversation is not complete yet.'),
    ),
  },
)

export default definePipe({
  id: 'magic-8',
  initial: {
    phase: 'await_question',
    round: 0,
    question: '',
    last_answer: '',
    history: [],
  } satisfies Magic8Context,
  run: flow(conversationStep, ensureCompletion),
})
