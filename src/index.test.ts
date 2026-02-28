import {spawnSync} from 'node:child_process'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'
import * as api from './index'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

describe('public library API', () => {
  it('exports an explicit stable runtime surface', () => {
    expect(Object.keys(api).sort()).toEqual([
      'agentSandbox',
      'agentSandboxEffect',
      'ask',
      'askForRepo',
      'askForRepoEffect',
      'createOrchestrationLayer',
      'createOrchestrationTestLayer',
      'createOrchestrationUtilities',
      'createOrchestrationUtilitiesFromLayer',
      'decide',
      'defaultOrchestrationAdapters',
      'defaultOrchestrationLayer',
      'defineConfig',
      'definePipe',
      'end',
      'flow',
      'invokeAgent',
      'invokeAgentEffect',
      'loop',
      'runOrchestrationEffect',
      'step',
      'write',
    ])
    expect(api).not.toHaveProperty('publish')
    expect(api).not.toHaveProperty('retry')
    expect(api).not.toHaveProperty('route')
    expect(api).not.toHaveProperty('compileExpressiveFactory')
  })

  it('typechecks package-root imports for config, factory, and helpers', () => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
        '--project',
        path.join(repoRoot, 'e2e', 'fixtures', 'library-api', 'tsconfig.json'),
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    )

    const output = `${result.stdout}\n${result.stderr}`.trim()
    expect(result.status, output).toBe(0)
  })

  it('typechecks canonical primitive contract signatures', () => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
        '--project',
        path.join(
          repoRoot,
          'e2e',
          'fixtures',
          'canonical-contracts',
          'tsconfig.json',
        ),
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    )

    const output = `${result.stdout}\n${result.stderr}`.trim()
    expect(result.status, output).toBe(0)
  })
})
