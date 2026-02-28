const QUESTIONS = [
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

const pick = items => items[Math.floor(Math.random() * items.length)]

const selectionDone = ({ctx}) => String(ctx.phase ?? '') === 'done'

const agentTurn = async ({ctx}) => {
  const phase = String(ctx.phase ?? 'ask')
  console.log('Would-you-rather agent phase:', phase)

  if (phase === 'ask') {
    const question = pick(QUESTIONS)
    return {
      status: 'feedback',
      message: [
        question.prompt,
        '',
        `A) ${question.optionA}`,
        `B) ${question.optionB}`,
        '',
        'Reply with A or B.',
      ].join('\n'),
      data: {
        current_prompt: question.prompt,
        option_a: question.optionA,
        option_b: question.optionB,
        phase: 'await_choice',
        human_feedback: null,
      },
    }
  }

  if (phase === 'reveal') {
    const chosen = String(ctx.choice ?? '').toUpperCase()
    const winner =
      chosen === 'A' ? String(ctx.option_a ?? 'A') : String(ctx.option_b ?? 'B')

    return {
      status: 'done',
      page: {
        markdown: [
          '# Would You Rather',
          String(ctx.current_prompt ?? ''),
          '',
          `Choice: ${chosen}) ${winner}`,
          'Outcome: Bold choice. No take-backs.',
        ].join('\n'),
      },
      data: {phase: 'done'},
    }
  }

  if (phase === 'done') {
    return {status: 'done'}
  }

  return {
    status: 'failed',
    message: `Unknown phase: ${phase}`,
  }
}

const userTurn = async ({ctx}) => {
  const phase = String(ctx.phase ?? '')
  const reply = String(ctx.human_feedback ?? '').trim()

  if (phase !== 'await_choice') {
    return {
      status: 'failed',
      message: `Unexpected phase for user input: ${phase}`,
    }
  }

  if (!reply) {
    return {
      status: 'feedback',
      message: 'Please reply with A or B.',
    }
  }

  return {
    status: 'done',
    data: {
      choice_reply: reply,
      human_feedback: null,
      phase: 'route_choice',
    },
  }
}

const routeChoice = ({ctx}) => {
  const phase = String(ctx.phase ?? '')
  if (phase !== 'route_choice') return 'invalid'

  const reply = String(ctx.choice_reply ?? '')
    .trim()
    .toUpperCase()
  if (reply.startsWith('A')) return 'choose_a'
  if (reply.startsWith('B')) return 'choose_b'
  return 'retry'
}

const chooseA = async () => ({
  status: 'done',
  data: {
    choice: 'A',
    phase: 'reveal',
  },
})

const chooseB = async () => ({
  status: 'done',
  data: {
    choice: 'B',
    phase: 'reveal',
  },
})

const retryChoice = async () => ({
  status: 'feedback',
  message: 'Please reply with only A or B.',
  data: {phase: 'await_choice'},
})

export default {
  id: 'would-you-rather',
  start: 'conversation_loop',
  context: {phase: 'ask'},
  guards: {selectionDone},
  states: {
    conversation_loop: {
      type: 'loop',
      body: 'agent_turn',
      maxIterations: 6,
      until: 'selectionDone',
      on: {
        continue: 'agent_turn',
        done: 'done',
        exhausted: 'failed',
      },
    },
    agent_turn: {
      type: 'action',
      agent: agentTurn,
      on: {
        done: 'conversation_loop',
        feedback: 'wait_for_user',
        failed: 'failed',
      },
    },
    wait_for_user: {
      type: 'feedback',
      resume: 'user_turn',
    },
    user_turn: {
      type: 'action',
      agent: userTurn,
      on: {
        done: 'route_choice',
        feedback: 'wait_for_user',
        failed: 'failed',
      },
    },
    route_choice: {
      type: 'orchestrate',
      select: routeChoice,
      on: {
        choose_a: 'choose_a',
        choose_b: 'choose_b',
        retry: 'retry_choice',
        invalid: 'failed',
      },
    },
    choose_a: {
      type: 'action',
      agent: chooseA,
      on: {done: 'conversation_loop', failed: 'failed'},
    },
    choose_b: {
      type: 'action',
      agent: chooseB,
      on: {done: 'conversation_loop', failed: 'failed'},
    },
    retry_choice: {
      type: 'action',
      agent: retryChoice,
      on: {done: 'route_choice', feedback: 'wait_for_user', failed: 'failed'},
    },
    done: {type: 'done'},
    failed: {type: 'failed'},
  },
}
