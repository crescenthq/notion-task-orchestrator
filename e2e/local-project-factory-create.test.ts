import {stat} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {
  assertNoNewGlobalNotionflowWrites,
  createTempProjectFixture,
  snapshotGlobalNotionflowWrites,
  type TempProjectFixture,
} from './helpers/projectFixture'

describe('local project factory create', () => {
  const fixtures: TempProjectFixture[] = []

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop()
      if (!fixture) {
        continue
      }

      await fixture.cleanup()
    }
  })

  it('creates factories/<id>.ts in local project context without global writes', async () => {
    const before = await snapshotGlobalNotionflowWrites()
    const fixture = await createTempProjectFixture()
    fixtures.push(fixture)

    await execCli(['init'], fixture.projectDir)
    await execCli(
      ['factory', 'create', '--id', 'smoke', '--skip-notion-board'],
      fixture.projectDir,
    )

    await expect(
      stat(path.join(fixture.projectDir, 'factories', 'smoke.ts')),
    ).resolves.toBeTruthy()

    const after = await snapshotGlobalNotionflowWrites()
    assertNoNewGlobalNotionflowWrites(before, after)
  })

  it('creates factories with --config when run outside the project', async () => {
    const before = await snapshotGlobalNotionflowWrites()
    const fixture = await createTempProjectFixture()
    fixtures.push(fixture)
    const outsider = await createTempProjectFixture('notionflow-e2e-outside-')
    fixtures.push(outsider)

    await execCli(['init'], fixture.projectDir)
    const configPath = path.join(fixture.projectDir, 'notionflow.config.ts')

    await execCli(
      [
        'factory',
        'create',
        '--id',
        'external',
        '--config',
        configPath,
        '--skip-notion-board',
      ],
      outsider.projectDir,
    )

    await expect(
      stat(path.join(fixture.projectDir, 'factories', 'external.ts')),
    ).resolves.toBeTruthy()

    const after = await snapshotGlobalNotionflowWrites()
    assertNoNewGlobalNotionflowWrites(before, after)
  })
})

async function execCli(args: string[], cwd: string): Promise<void> {
  const cliPath = path.resolve(process.cwd(), 'src/cli.ts')
  const tsxLoaderPath = path.resolve(
    process.cwd(),
    'node_modules',
    'tsx',
    'dist',
    'loader.mjs',
  )

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', tsxLoaderPath, cliPath, ...args],
      {
      cwd,
      stdio: 'pipe',
      env: process.env,
      },
    )

    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })

    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolve()
        return
      }

      reject(
        new Error(
          `Command failed (${code ?? -1}): notionflow ${args.join(' ')}\n${stderr}`,
        ),
      )
    })
  })
}
