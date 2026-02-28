import {spawnSync} from 'node:child_process'

const promptQuestion = async () => {
  console.log('Prompting for a Magic 8-Ball question...')

  return {
    status: 'feedback',
    message: 'Magic 8-Ball: Ask the Magic 8-Ball a yes/no question.',
    data: {phase: 'await_question'},
  }
}

const captureFeedback = async ({ctx}) => {
  const phase = String(ctx.phase ?? '')
  const reply = String(ctx.human_feedback ?? '').trim()

  if (!reply) {
    if (phase === 'await_replay') {
      return {
        status: 'feedback',
        message: 'Please reply with yes or no.',
      }
    }

    return {
      status: 'feedback',
      message: 'I did not catch that. Ask a yes/no question.',
    }
  }

  if (phase === 'await_question') {
    return {
      status: 'done',
      data: {
        question: reply,
        human_feedback: null,
        phase: 'have_question',
      },
    }
  }

  if (phase === 'await_replay') {
    return {
      status: 'done',
      data: {
        again_reply: reply,
        human_feedback: null,
        phase: 'have_replay_decision',
      },
    }
  }

  return {
    status: 'failed',
    message: `Unexpected phase: ${phase}`,
  }
}

const routeAfterFeedback = ({ctx}) => {
  const phase = String(ctx.phase ?? '')

  if (phase === 'have_question') return 'answer'

  if (phase === 'have_replay_decision') {
    const reply = String(ctx.again_reply ?? '')
      .trim()
      .toLowerCase()
    if (reply.startsWith('y')) return 'again'
    if (reply.startsWith('n')) return 'finish'
    return 'clarify'
  }

  return 'invalid'
}

const answerQuestion = async ({ctx}) => {
  const question = String(ctx.question ?? '').trim()
  const prompt = `You are a Magic 8-Ball.\nQuestion: "${question || 'Will this work?'}"\nReturn exactly one short, playful answer line.\nNo quotes. No prefixes.`

  const result = spawnSync(
    'opencode',
    ['run', prompt, '--agent', 'build', '--model', 'opencode/kimi-k2.5'],
    {encoding: 'utf-8'},
  )

  const answer = result.stdout.trim() || 'Reply hazy, try again.'

  return {
    status: 'feedback',
    message: `Magic 8-Ball: ${answer}\n\nAsk another? (yes/no)`,
    data: {
      last_answer: answer,
      phase: 'await_replay',
    },
  }
}

const clarifyReplay = async () => {
  return {
    status: 'feedback',
    message: 'Please reply with yes or no. Ask another question?',
    data: {phase: 'await_replay'},
  }
}

const finalizeRun = async ({ctx}) => {
  const question = String(ctx.question ?? '(no question)')
  const answer = String(ctx.last_answer ?? '(no answer)')

  return {
    status: 'done',
    page: {
      markdown: [
        'Magic 8-Ball',
        `Question: ${question}`,
        `Answer: ${answer}`,
      ].join('\n'),
    },
    data: {phase: 'done'},
  }
}

export default {
  id: 'magic-8-ball',
  start: 'prompt_question',
  context: {phase: 'await_question'},
  states: {
    prompt_question: {
      type: 'action',
      agent: promptQuestion,
      on: {
        done: 'capture_feedback',
        feedback: 'wait_feedback',
        failed: 'failed',
      },
    },
    wait_feedback: {
      type: 'feedback',
      resume: 'capture_feedback',
    },
    capture_feedback: {
      type: 'action',
      agent: captureFeedback,
      on: {
        done: 'route_after_feedback',
        feedback: 'wait_feedback',
        failed: 'failed',
      },
    },
    route_after_feedback: {
      type: 'orchestrate',
      select: routeAfterFeedback,
      on: {
        answer: 'answer_question',
        again: 'prompt_question',
        finish: 'finalize_run',
        clarify: 'clarify_replay',
        invalid: 'failed',
      },
    },
    answer_question: {
      type: 'action',
      agent: answerQuestion,
      on: {
        done: 'route_after_feedback',
        feedback: 'wait_feedback',
        failed: 'failed',
      },
    },
    clarify_replay: {
      type: 'action',
      agent: clarifyReplay,
      on: {
        done: 'route_after_feedback',
        feedback: 'wait_feedback',
        failed: 'failed',
      },
    },
    finalize_run: {
      type: 'action',
      agent: finalizeRun,
      on: {done: 'done', failed: 'failed'},
    },
    done: {type: 'done'},
    failed: {type: 'failed'},
  },
}
