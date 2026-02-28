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
      'agent',
      'defineConfig',
      'defineFactory',
      'select',
      'until',
    ])
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
})
