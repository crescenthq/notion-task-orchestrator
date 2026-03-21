import {describe, expect, it} from 'vitest'
import {renderDashboardScreen} from './screen'
import type {DashboardTextView} from './text'

function stripAnsi(input: string): string {
  return input.replace(
    new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'),
    '',
  )
}

function makeView(): DashboardTextView {
  return {
    header: [
      'PIPES DASHBOARD',
      'Project: demo',
      'Path: /tmp/demo',
      'Runtime DB: /tmp/demo/.pipes-runtime/pipes.db',
      'Tasks 3  |  Active 1  |  Updated 10:01  |  Last event 8s',
    ].join('\n'),
    summary:
      'States\nRunning       1\nFeedback      0\nQueued        2\nFailed        0\nBlocked       0\nDone          0\n\nPipes\neditorial      3 total  1 active',
    inProgress:
      'TASK           PIPE          STATE        STEP             UPDATED\n---------------------------------------------------------------------\npage-run-123   editorial     running      draft_copy       8s',
    tasks:
      'TASK           PIPE        STATE        STEP          AGE      DETAIL\n----------------------------------------------------------------------\npage-run-123   editorial   running      draft_copy    8s       Lease owner worker-42 with a very long detail message that should truncate',
    events:
      'TIME      TASK          EVENT                              AGE\n---------------------------------------------------------------------\n10:01:00  page-run-123  task moved to running state          8s',
    footer: 'q quit  |  r refresh',
  }
}

describe('dashboard screen', () => {
  it('renders the ledger dashboard with the expected sections and density', () => {
    const frame = stripAnsi(
      renderDashboardScreen(makeView(), {
        columns: 96,
        rows: 24,
      }),
    )
    const lines = frame.split('\n')

    expect(lines.every(line => line.length <= 96)).toBe(true)
    expect(frame).toContain('PIPES / DEMO')
    expect(frame).toContain('LEDGER')
    expect(frame).toContain('running 1')
    expect(frame).toContain('pipe editorial')
    expect(frame).toContain('NOW')
    expect(frame).toContain('QUEUE')
    expect(frame).toContain('EVENT')
    expect(frame).not.toContain('Runtime DB')
    expect(frame).toContain('worker-42')
    expect(frame).toContain('q quit')
  })

  it('stays readable at the minimum terminal width', () => {
    const frame = stripAnsi(
      renderDashboardScreen(
        {
          header: [
            'PIPES DASHBOARD',
            'Project: narrow',
            'Tasks 0  |  Active 0  |  Updated n/a  |  Last event n/a',
          ].join('\n'),
          summary:
            'States\nRunning       0\nFeedback      0\nQueued        0\nFailed        0\nBlocked       0\nDone          0\n\nPipes\nNo pipes registered yet.',
          inProgress: 'No tasks are currently running or waiting for feedback.',
          tasks:
            'No local tasks found. Run `pipes integrations notion sync` or create a task first.',
          events: 'No run trace activity recorded yet.',
          footer: 'q quit  |  r refresh',
        },
        {columns: 72, rows: 20},
      ),
    )

    expect(frame.split('\n').every(line => line.length <= 72)).toBe(true)
    expect(frame).toContain('LEDGER')
    expect(frame).toContain('pipes none')
    expect(frame).toContain('No recent activity recorded yet.')
  })
})
