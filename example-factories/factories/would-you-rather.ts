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

type RatherQuestion = {
  prompt: string
  optionA: string
  optionB: string
}

type RatherContext = {
  question_index: number
  current_prompt: string
  option_a: string
  option_b: string
  choice: 'A' | 'B' | ''
  selected_option: string
  complete: boolean
}

const QUESTIONS: RatherQuestion[] = [
  {
    prompt: 'Would you rather have a pet dragon or a pet dinosaur?',
    optionA: 'Pet dragon',
    optionB: 'Pet dinosaur',
  },
  {
    prompt: 'Would you rather always speak in rhymes or only whisper forever?',
    optionA: 'Always speak in rhymes',
    optionB: 'Only whisper forever',
  },
  {
    prompt: 'Would you rather live on a pirate ship or in a treehouse city?',
    optionA: 'Pirate ship',
    optionB: 'Treehouse city',
  },
]

const selectQuestion = step<RatherContext>('select-question', ctx => {
  if (ctx.current_prompt && !ctx.complete) {
    return ctx
  }

  const index = Number(ctx.question_index ?? 0)
  const selected = QUESTIONS[index % QUESTIONS.length]

  return {
    ...ctx,
    question_index: index + 1,
    current_prompt: selected?.prompt ?? 'Would you rather pick option A or B?',
    option_a: selected?.optionA ?? 'Option A',
    option_b: selected?.optionB ?? 'Option B',
    choice: '',
    selected_option: '',
    complete: false,
  }
})

const captureChoice = ask<RatherContext>(
  ctx =>
    [
      ctx.current_prompt,
      '',
      `A) ${ctx.option_a}`,
      `B) ${ctx.option_b}`,
      '',
      'Reply with A or B.',
    ].join('\n'),
  (ctx, reply) => {
    const normalized = reply.trim().toUpperCase()

    if (normalized.startsWith('A')) {
      return {
        ...ctx,
        choice: 'A',
      }
    }

    if (normalized.startsWith('B')) {
      return {
        ...ctx,
        choice: 'B',
      }
    }

    return {
      type: 'await_feedback',
      prompt: 'Please reply with only A or B.',
      ctx,
    }
  },
)

const applyChoice = decide<RatherContext, 'choose_a' | 'choose_b'>(
  ctx => (ctx.choice === 'A' ? 'choose_a' : 'choose_b'),
  {
    choose_a: step('choose-a', ctx => ({
      ...ctx,
      selected_option: ctx.option_a,
      complete: true,
    })),
    choose_b: step('choose-b', ctx => ({
      ...ctx,
      selected_option: ctx.option_b,
      complete: true,
    })),
  },
)

export default definePipe({
  id: 'would-you-rather',
  initial: {
    question_index: 0,
    current_prompt: '',
    option_a: '',
    option_b: '',
    choice: '',
    selected_option: '',
    complete: false,
  } as RatherContext,
  run: flow(
    loop({
      body: flow(selectQuestion, captureChoice, applyChoice),
      until: ctx => Boolean(ctx.complete),
      max: 3,
      onExhausted: end.failed('No valid A/B choice received before loop exhaustion.'),
    }),
    write(ctx => ({
      markdown: [
        '# Would You Rather',
        ctx.current_prompt,
        '',
        `Choice: ${ctx.choice}) ${ctx.selected_option}`,
        'Outcome: Bold choice. No take-backs.',
      ].join('\n'),
    })),
    end.done(),
  ),
})
