import {mkdir, realpath} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {
  assertNoNewGlobalNotionflowWrites,
  createTempProjectFixture,
  snapshotGlobalNotionflowWrites,
  type TempProjectFixture,
} from './helpers/projectFixture'

describe('local project doctor', () => {
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

  it('discovers project config from nested directory and reports resolved paths', async () => {
    const before = await snapshotGlobalNotionflowWrites()
    const fixture = await createTempProjectFixture()
    fixtures.push(fixture)

    await execCli(['init'], fixture.projectDir)

    const nestedDir = path.join(fixture.projectDir, 'nested', 'child')
    await mkdir(nestedDir, {recursive: true})

    const canonicalProjectRoot = await realpath(fixture.projectDir)
    const doctorOutput = await execCli(['doctor'], nestedDir)
    expect(doctorOutput).toContain(`Project root: ${canonicalProjectRoot}`)
    expect(doctorOutput).toContain(
      `Config path: ${path.join(canonicalProjectRoot, 'notionflow.config.ts')}`,
    )

    const after = await snapshotGlobalNotionflowWrites()
    assertNoNewGlobalNotionflowWrites(before, after)
  })

  it('supports --config override from outside project', async () => {
    const before = await snapshotGlobalNotionflowWrites()
    const fixture = await createTempProjectFixture()
    fixtures.push(fixture)
    const outsider = await createTempProjectFixture('notionflow-e2e-outside-')
    fixtures.push(outsider)

    await execCli(['init'], fixture.projectDir)

    const canonicalProjectRoot = await realpath(fixture.projectDir)
    const configPath = path.join(canonicalProjectRoot, 'notionflow.config.ts')
    const doctorOutput = await execCli(
      ['doctor', '--config', configPath],
      outsider.projectDir,
    )
    expect(doctorOutput).toContain(`Project root: ${canonicalProjectRoot}`)
    expect(doctorOutput).toContain(`Config path: ${configPath}`)

    const after = await snapshotGlobalNotionflowWrites()
    assertNoNewGlobalNotionflowWrites(before, after)
  })

  it('fails with actionable context when config cannot be resolved', async () => {
    const fixture = await createTempProjectFixture(
      'notionflow-e2e-missing-config-',
    )
    fixtures.push(fixture)

    const result = await execCliRaw(['doctor'], fixture.projectDir)
    const canonicalStartDir = await realpath(fixture.projectDir)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('Could not find notionflow.config.ts')
    expect(result.stderr).toContain(`Start directory: ${canonicalStartDir}`)
  })
})

async function execCli(args: string[], cwd: string): Promise<string> {
  const result = await execCliRaw(args, cwd)
  if (result.code === 0) {
    return result.stdout
  }

  throw new Error(
    `Command failed (${result.code ?? -1}): notionflow ${args.join(' ')}\n${result.stderr}`,
  )
}

async function execCliRaw(
  args: string[],
  cwd: string,
): Promise<{stdout: string; stderr: string; code: number | null}> {
  const cliPath = path.resolve(process.cwd(), 'src/cli.ts')

  return new Promise<{stdout: string; stderr: string; code: number | null}>(
    (resolve, reject) => {
      const child = spawn('npx', ['tsx', cliPath, ...args], {
        cwd,
        stdio: 'pipe',
        env: process.env,
      })

      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => {
        stdout += String(chunk)
      })
      child.stderr.on('data', chunk => {
        stderr += String(chunk)
      })

      child.on('error', reject)
      child.on('close', code => {
        resolve({stdout, stderr, code})
      })
    },
  )
}
