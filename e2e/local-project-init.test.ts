import {readFile, stat} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {
  assertNoNewGlobalNotionflowWrites,
  createTempProjectFixture,
  snapshotGlobalNotionflowWrites,
  type TempProjectFixture,
} from './helpers/projectFixture'

describe('local project init', () => {
  let fixture: TempProjectFixture | null = null

  afterEach(async () => {
    if (!fixture) {
      return
    }

    await fixture.cleanup()
    fixture = null
  })

  it('scaffolds config, factories, runtime dir, and idempotent gitignore entry', async () => {
    const before = await snapshotGlobalNotionflowWrites()
    fixture = await createTempProjectFixture()

    await execCli(['init'], fixture.projectDir)
    await execCli(['init'], fixture.projectDir)

    await expect(
      stat(path.join(fixture.projectDir, 'notionflow.config.ts')),
    ).resolves.toBeTruthy()
    await expect(
      stat(path.join(fixture.projectDir, 'factories')),
    ).resolves.toBeTruthy()
    await expect(
      stat(path.join(fixture.projectDir, '.notionflow')),
    ).resolves.toBeTruthy()

    const gitignore = await readFile(
      path.join(fixture.projectDir, '.gitignore'),
      'utf8',
    )
    const runtimeIgnoreCount = gitignore
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line === '.notionflow/').length
    expect(runtimeIgnoreCount).toBe(1)

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
