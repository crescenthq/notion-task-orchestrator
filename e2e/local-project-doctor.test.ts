import {execFile, spawn} from 'node:child_process'
import {existsSync} from 'node:fs'
import {mkdir, realpath, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {
  assertNoNewGlobalPipesWrites,
  createTempProjectFixture,
  snapshotGlobalPipesWrites,
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
    const before = await snapshotGlobalPipesWrites()
    const fixture = await createTempProjectFixture()
    fixtures.push(fixture)

    await execCli(['init'], fixture.projectDir)
    await writeFile(
      path.join(fixture.projectDir, 'pipes.config.ts'),
      'export default {};\n',
      'utf8',
    )
    await initGitRepo(fixture.projectDir)
    await commitAll(fixture.projectDir, 'doctor project fixture')

    const nestedDir = path.join(fixture.projectDir, 'nested', 'child')
    await mkdir(nestedDir, {recursive: true})

    const canonicalProjectRoot = await realpath(fixture.projectDir)
    const doctorOutput = await execCli(['doctor'], nestedDir)
    expect(doctorOutput).toContain(`Project root: ${canonicalProjectRoot}`)
    expect(doctorOutput).toContain(
      `Config path: ${path.join(canonicalProjectRoot, 'pipes.config.ts')}`,
    )
    expect(doctorOutput).toContain(
      'Workspace execution: default project repo',
    )
    expect(doctorOutput).toContain(`Workspace repo: ${canonicalProjectRoot}`)
    expect(doctorOutput).toContain('Workspace cwd: .')
    expect(
      existsSync(path.join(fixture.projectDir, '.pipes-runtime', 'workspaces')),
    ).toBe(false)

    const after = await snapshotGlobalPipesWrites()
    assertNoNewGlobalPipesWrites(before, after)
  })

  it('supports --config override from outside project', async () => {
    const before = await snapshotGlobalPipesWrites()
    const fixture = await createTempProjectFixture()
    fixtures.push(fixture)
    const outsider = await createTempProjectFixture('pipes-e2e-outside-')
    fixtures.push(outsider)

    await execCli(['init'], fixture.projectDir)
    await writeFile(
      path.join(fixture.projectDir, 'pipes.config.ts'),
      'export default {};\n',
      'utf8',
    )
    await initGitRepo(fixture.projectDir)
    await commitAll(fixture.projectDir, 'doctor config override fixture')

    const canonicalProjectRoot = await realpath(fixture.projectDir)
    const configPath = path.join(canonicalProjectRoot, 'pipes.config.ts')
    const doctorOutput = await execCli(
      ['doctor', '--config', configPath],
      outsider.projectDir,
    )
    expect(doctorOutput).toContain(`Project root: ${canonicalProjectRoot}`)
    expect(doctorOutput).toContain(`Config path: ${configPath}`)
    expect(doctorOutput).toContain(
      'Workspace execution: default project repo',
    )

    const after = await snapshotGlobalPipesWrites()
    assertNoNewGlobalPipesWrites(before, after)
  })

  it('reports explicit workspace URL overrides from projects outside git repos', async () => {
    const before = await snapshotGlobalPipesWrites()
    const sourceRepo = await createTempProjectFixture('pipes-e2e-source-')
    fixtures.push(sourceRepo)
    const project = await createTempProjectFixture('pipes-e2e-explicit-')
    fixtures.push(project)

    await initGitRepo(sourceRepo.projectDir)
    await writeFile(
      path.join(sourceRepo.projectDir, 'README.md'),
      'explicit workspace source\n',
      'utf8',
    )
    await commitAll(sourceRepo.projectDir, 'explicit workspace source')

    await execCli(['init'], project.projectDir)
    await writeFile(
      path.join(project.projectDir, 'pipes.config.ts'),
      [
        'export default {',
        `  workspace: ${JSON.stringify(`file://${await realpath(sourceRepo.projectDir)}`)},`,
        '};',
        '',
      ].join('\n'),
      'utf8',
    )

    const doctorOutput = await execCli(['doctor'], project.projectDir)
    expect(doctorOutput).toContain(
      'Workspace execution: explicit workspace override',
    )
    expect(doctorOutput).toContain(
      `Workspace repo: file://${await realpath(sourceRepo.projectDir)}`,
    )
    expect(doctorOutput).toContain('Workspace cwd: .')
    expect(
      existsSync(path.join(project.projectDir, '.pipes-runtime', 'workspaces')),
    ).toBe(false)

    const after = await snapshotGlobalPipesWrites()
    assertNoNewGlobalPipesWrites(before, after)
  })

  it('validates explicit workspace refs without requiring remote HEAD', async () => {
    const before = await snapshotGlobalPipesWrites()
    const sourceRepo = await createTempProjectFixture(
      'pipes-e2e-source-no-head-',
    )
    fixtures.push(sourceRepo)
    const project = await createTempProjectFixture(
      'pipes-e2e-explicit-no-head-',
    )
    fixtures.push(project)

    await initGitRepo(sourceRepo.projectDir)
    await writeFile(
      path.join(sourceRepo.projectDir, 'README.md'),
      'explicit workspace source without head\n',
      'utf8',
    )
    await commitAll(sourceRepo.projectDir, 'explicit workspace source without head')
    await runGit(['checkout', '-b', 'feature/stable'], sourceRepo.projectDir)
    const stableHead = await runGit(
      ['rev-parse', '--verify', 'feature/stable^{commit}'],
      sourceRepo.projectDir,
    )
    await runGit(
      ['symbolic-ref', 'HEAD', 'refs/heads/missing-head'],
      sourceRepo.projectDir,
    )

    await execCli(['init'], project.projectDir)
    await writeFile(
      path.join(project.projectDir, 'pipes.config.ts'),
      [
        'export default {',
        '  workspace: {',
        `    repo: ${JSON.stringify(`file://${await realpath(sourceRepo.projectDir)}`)},`,
        '    ref: "feature/stable",',
        '  },',
        '};',
        '',
      ].join('\n'),
      'utf8',
    )

    const doctorOutput = await execCli(['doctor'], project.projectDir)
    expect(doctorOutput).toContain(
      `Workspace repo: file://${await realpath(sourceRepo.projectDir)}`,
    )
    expect(doctorOutput).toContain(
      `Workspace ref: feature/stable -> ${stableHead}`,
    )

    const after = await snapshotGlobalPipesWrites()
    assertNoNewGlobalPipesWrites(before, after)
  })

  it('fails with actionable context when config cannot be resolved', async () => {
    const fixture = await createTempProjectFixture(
      'pipes-e2e-missing-config-',
    )
    fixtures.push(fixture)

    const result = await execCliRaw(['doctor'], fixture.projectDir)
    const canonicalStartDir = await realpath(fixture.projectDir)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('Could not find pipes.config.ts')
    expect(result.stderr).toContain(`Start directory: ${canonicalStartDir}`)
  })
})

async function initGitRepo(repoRoot: string): Promise<void> {
  await runGit(['init'], repoRoot)
  await runGit(['config', 'user.name', 'Pipes Test'], repoRoot)
  await runGit(['config', 'user.email', 'pipes@example.com'], repoRoot)
}

async function commitAll(repoRoot: string, message: string): Promise<void> {
  await runGit(['add', '.'], repoRoot)
  await runGit(['commit', '-m', message], repoRoot)
}

async function execCli(args: string[], cwd: string): Promise<string> {
  const result = await execCliRaw(args, cwd)
  if (result.code === 0) {
    return result.stdout
  }

  throw new Error(
    `Command failed (${result.code ?? -1}): pipes ${args.join(' ')}\n${result.stderr}`,
  )
}

async function execCliRaw(
  args: string[],
  cwd: string,
): Promise<{stdout: string; stderr: string; code: number | null}> {
  const cliPath = path.resolve(process.cwd(), 'src/cli.ts')
  const tsxLoaderPath = path.resolve(
    process.cwd(),
    'node_modules',
    'tsx',
    'dist',
    'loader.mjs',
  )

  return new Promise<{stdout: string; stderr: string; code: number | null}>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', tsxLoaderPath, cliPath, ...args],
        {
          cwd,
          stdio: 'pipe',
          env: process.env,
        },
      )

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

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {cwd, encoding: 'utf8'}, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message))
        return
      }

      resolve(stdout.trim())
    })
  })
}
