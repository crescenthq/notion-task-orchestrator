import {describe, expect, it} from 'vitest'
import expressivePrimitives from '../../example-factories/pipes/expressive-primitives'
import intentFactory from '../../example-factories/pipes/intent'
import magic8Factory from '../../example-factories/pipes/magic-8'
import sharedHelperDemo from '../../example-factories/pipes/shared-helper-demo'
import wouldYouRatherFactory from '../../example-factories/pipes/would-you-rather'
import type {PipeWorkspace, TaskHandle} from './canonical'

type AwaitFeedbackSignal = {
  type: 'await_feedback'
  prompt: string
  ctx: Record<string, unknown>
}

type EndSignal = {
  type: 'end'
  status: 'done' | 'blocked' | 'failed'
  ctx: Record<string, unknown>
  message?: string
}

const mockWorkspace: PipeWorkspace = {
  root: '/tmp/pipes-workspace',
  cwd: '/tmp/pipes-workspace/app',
  ref: 'deadbeef',
  source: {
    mode: 'project',
    repo: '/tmp/pipes-source',
    requestedRef: 'HEAD',
  },
}

function createTaskHandle(
  overrides: Partial<TaskHandle> & Pick<TaskHandle, 'id' | 'title'>,
): TaskHandle {
  return {
    id: overrides.id,
    title: overrides.title,
    readArtifact: overrides.readArtifact ?? (async () => ''),
    writeArtifact: overrides.writeArtifact ?? (async () => undefined),
    updateStatus: overrides.updateStatus ?? (async () => undefined),
    comment: overrides.comment ?? (async () => undefined),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function expectAwaitFeedback(value: unknown): AwaitFeedbackSignal {
  if (
    !isRecord(value) ||
    value.type !== 'await_feedback' ||
    typeof value.prompt !== 'string' ||
    !isRecord(value.ctx)
  ) {
    throw new Error(
      `Expected await_feedback signal, got: ${JSON.stringify(value)}`,
    )
  }

  return value as AwaitFeedbackSignal
}

function expectEnd(value: unknown): EndSignal {
  if (
    !isRecord(value) ||
    value.type !== 'end' ||
    (value.status !== 'done' &&
      value.status !== 'blocked' &&
      value.status !== 'failed') ||
    !isRecord(value.ctx)
  ) {
    throw new Error(`Expected end signal, got: ${JSON.stringify(value)}`)
  }

  return value as EndSignal
}

describe('example pipes smoke', () => {
  it('runs expressive-primitives through the approve path', async () => {
    const writes: string[] = []

    const result = await expressivePrimitives.run({
      ctx: expressivePrimitives.initial,
      feedback: 'approve',
      workspace: mockWorkspace,
      runId: 'run-expressive',
      tickId: 'tick-expressive',
      task: createTaskHandle({
        id: 'task-expressive',
        title: 'Expressive primitives task',
        writeArtifact: async markdown => {
          writes.push(markdown)
        },
      }),
    })

    const end = expectEnd(result)
    expect(end.status).toBe('done')
    expect(end.ctx.decision).toBe('approve')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('Expressive Primitive Demo')
  })

  it('runs shared-helper-demo to completion', async () => {
    const writes: string[] = []

    const result = await sharedHelperDemo.run({
      ctx: sharedHelperDemo.initial,
      workspace: mockWorkspace,
      runId: 'run-shared',
      tickId: 'tick-shared',
      task: createTaskHandle({
        id: 'task-shared',
        title: 'Shared helper task',
        writeArtifact: async markdown => {
          writes.push(markdown)
        },
      }),
    })

    const end = expectEnd(result)
    expect(end.status).toBe('done')
    expect(end.ctx.finished).toBe(true)
    expect(end.ctx.attempts).toBe(2)
    expect(writes).toHaveLength(1)
  })

  it('supports pause/resume in magic-8 flow', async () => {
    const first = await magic8Factory.run({
      ctx: magic8Factory.initial,
      workspace: mockWorkspace,
      runId: 'run-magic-1',
      tickId: 'tick-magic-1',
      task: createTaskHandle({
        id: 'task-magic',
        title: 'Magic 8 task',
      }),
    })
    const firstAwait = expectAwaitFeedback(first)
    expect(firstAwait.prompt).toContain('Ask a yes/no question')

    const second = await magic8Factory.run({
      ctx: firstAwait.ctx as typeof magic8Factory.initial,
      feedback: 'Will this release go smoothly?',
      workspace: mockWorkspace,
      runId: 'run-magic-2',
      tickId: 'tick-magic-2',
      task: createTaskHandle({
        id: 'task-magic',
        title: 'Magic 8 task',
      }),
    })
    const secondAwait = expectAwaitFeedback(second)
    expect(secondAwait.prompt).toContain('Ask another? (yes/no)')

    const writes: string[] = []
    const third = await magic8Factory.run({
      ctx: secondAwait.ctx as typeof magic8Factory.initial,
      feedback: 'no',
      workspace: mockWorkspace,
      runId: 'run-magic-3',
      tickId: 'tick-magic-3',
      task: createTaskHandle({
        id: 'task-magic',
        title: 'Magic 8 task',
        writeArtifact: async markdown => {
          writes.push(markdown)
        },
      }),
    })
    const finalEnd = expectEnd(third)
    expect(finalEnd.status).toBe('done')
    expect(Array.isArray(finalEnd.ctx.history)).toBe(true)
    expect((finalEnd.ctx.history as unknown[]).length).toBe(1)
    expect(writes).toHaveLength(1)
  })

  it('handles invalid then valid input in would-you-rather', async () => {
    const first = await wouldYouRatherFactory.run({
      ctx: wouldYouRatherFactory.initial,
      workspace: mockWorkspace,
      runId: 'run-rather-1',
      tickId: 'tick-rather-1',
      task: createTaskHandle({
        id: 'task-rather',
        title: 'Would you rather task',
      }),
    })
    const firstAwait = expectAwaitFeedback(first)
    expect(firstAwait.prompt).toContain('Reply with A or B')

    const second = await wouldYouRatherFactory.run({
      ctx: firstAwait.ctx as typeof wouldYouRatherFactory.initial,
      feedback: 'maybe',
      workspace: mockWorkspace,
      runId: 'run-rather-2',
      tickId: 'tick-rather-2',
      task: createTaskHandle({
        id: 'task-rather',
        title: 'Would you rather task',
      }),
    })
    const secondAwait = expectAwaitFeedback(second)
    expect(secondAwait.prompt).toContain('Please reply with only A or B')

    const writes: string[] = []
    const third = await wouldYouRatherFactory.run({
      ctx: secondAwait.ctx as typeof wouldYouRatherFactory.initial,
      feedback: 'A',
      workspace: mockWorkspace,
      runId: 'run-rather-3',
      tickId: 'tick-rather-3',
      task: createTaskHandle({
        id: 'task-rather',
        title: 'Would you rather task',
        writeArtifact: async markdown => {
          writes.push(markdown)
        },
      }),
    })
    const end = expectEnd(third)
    expect(end.status).toBe('done')
    expect(end.ctx.choice).toBe('A')
    expect(end.ctx.selected_option).toBeTruthy()
    expect(writes).toHaveLength(1)
  })

  it('captures an intent brief and completes in one reviewed pass', async () => {
    const first = await intentFactory.run({
      ctx: intentFactory.initial,
      workspace: mockWorkspace,
      runId: 'run-intent-1',
      tickId: 'tick-intent-1',
      task: createTaskHandle({
        id: 'task-intent',
        title: 'Intent task',
      }),
    })
    const awaitIntent = expectAwaitFeedback(first)
    expect(awaitIntent.prompt).toContain('Describe the request in one message')

    const writes: string[] = []
    const second = await intentFactory.run({
      ctx: awaitIntent.ctx as typeof intentFactory.initial,
      feedback:
        'repo=https://github.com/pipes/example.git; feature=Add a clear progress dashboard for task runs.; decision=approve',
      workspace: mockWorkspace,
      runId: 'run-intent-2',
      tickId: 'tick-intent-2',
      task: createTaskHandle({
        id: 'task-intent',
        title: 'Intent task',
        writeArtifact: async markdown => {
          writes.push(markdown)
        },
      }),
    })

    const end = expectEnd(second)
    expect(end.status).toBe('done')
    expect(end.ctx.review_decision).toBe('approve')
    expect(writes).toHaveLength(1)
  })
})
