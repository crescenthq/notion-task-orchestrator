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

describe('local project runtime artifacts', () => {
  let fixture: TempProjectFixture | null = null

  afterEach(async () => {
    if (!fixture) {
      return
    }

    await fixture.cleanup()
    fixture = null
  })

  it('writes db and runtime logs under project-local .notionflow with no global writes', async () => {
    const before = await snapshotGlobalNotionflowWrites()
    fixture = await createTempProjectFixture()

    await execCli(['init'], fixture.projectDir)
    await execCli(['factory', 'list'], fixture.projectDir)
    await execCli(['factory', 'list'], fixture.projectDir)

    const runtimeDir = path.join(fixture.projectDir, '.notionflow')
    await expect(
      stat(path.join(runtimeDir, 'notionflow.db')),
    ).resolves.toBeTruthy()
    await expect(
      stat(path.join(runtimeDir, 'runtime.log')),
    ).resolves.toBeTruthy()
    await expect(
      stat(path.join(runtimeDir, 'errors.log')),
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
