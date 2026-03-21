import {describe, expect, it} from 'vitest'
import {doctorCmd} from './commands/doctor'
import {pipeCmd} from './commands/pipe'
import {integrationsCmd} from './commands/integrations'
import {runCmd} from './commands/run'
import {startCmd} from './commands/start'
import {statusCmd} from './commands/status'
import {tickCmd} from './commands/tick'

function descriptionOf(command: unknown): string {
  const meta = (command as {meta?: unknown}).meta
  if (!meta || typeof meta !== 'object') return ''

  const description = (meta as {description?: unknown}).description
  return typeof description === 'string' ? description : ''
}

describe('CLI command categorization', () => {
  it('marks top-level commands as common, advanced, or integration', () => {
    expect(descriptionOf(pipeCmd)).toContain('[advanced]')
    expect(descriptionOf(doctorCmd)).toContain('[common]')
    expect(descriptionOf(startCmd)).toContain('[common]')
    expect(descriptionOf(tickCmd)).toContain('[common]')
    expect(descriptionOf(runCmd)).toContain('[common]')
    expect(descriptionOf(statusCmd)).toContain('[common]')

    expect(descriptionOf(integrationsCmd)).toContain('[integration]')
  })
})
