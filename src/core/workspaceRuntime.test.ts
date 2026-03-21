import {execFile} from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {resolveRuntimePaths} from '../config/paths'
import {
  loadProjectConfig,
  resolveWorkspaceConfig,
  type ResolvedWorkspaceConfig,
} from '../project/projectConfig'
import {
  cleanupRunWorkspace,
  provisionRunWorkspace,
  pruneWorkspaceArtifacts,
  validateWorkspaceSetup,
} from './workspaceRuntime'

const fixtures: string[] = []

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixturePath = fixtures.pop()
    if (!fixturePath) continue
    await rm(fixturePath, {recursive: true, force: true})
  }
})

describe('workspaceRuntime', () => {
  it('creates a managed mirror and run workspace for project-repo mode', async () => {
    const repoRoot = await createFixture(
      'notionflow-workspace-runtime-project-',
    )
    await initGitRepo(repoRoot)

    const projectRoot = path.join(repoRoot, 'packages', 'app')
    await mkdir(projectRoot, {recursive: true})
    const configPath = path.join(projectRoot, 'notionflow.config.ts')
    await writeFile(configPath, 'export default {};\n', 'utf8')
    await writeFile(
      path.join(projectRoot, 'README.md'),
      'project workspace\n',
      'utf8',
    )
    const initialHead = await commitAll(repoRoot, 'initial project workspace')

    const config = await loadProjectConfig(configPath)
    const workspace = await resolveWorkspaceConfig({
      config,
      projectRoot,
      configPath,
    })
    const runtimePaths = resolveRuntimePaths(projectRoot)

    const provisioned = await provisionRunWorkspace({
      paths: runtimePaths,
      projectRoot,
      workspace,
      runId: 'run-project-1',
    })

    expect(provisioned.root).toBe(
      path.join(runtimePaths.workspacesDir, 'run-project-1'),
    )
    expect(provisioned.cwd).toBe(path.join(provisioned.root, 'packages', 'app'))
    expect(provisioned.relativeCwd).toBe(path.join('packages', 'app'))
    expect(provisioned.repo).toBe(await realpath(repoRoot))
    expect(provisioned.requestedRef).toBe('HEAD')
    expect(provisioned.ref).toBe(initialHead)
    expect(
      await readFile(path.join(provisioned.cwd, 'README.md'), 'utf8'),
    ).toBe('project workspace\n')
    expect(
      await runGit(
        [
          '--git-dir',
          provisioned.mirrorPath,
          'rev-parse',
          '--is-bare-repository',
        ],
        projectRoot,
      ),
    ).toBe('true')

    const manifest = JSON.parse(
      await readFile(provisioned.manifestPath, 'utf8'),
    ) as Record<string, string>
    expect(manifest.root).toBe(provisioned.root)
    expect(manifest.cwd).toBe(provisioned.cwd)
    expect(manifest.ref).toBe(initialHead)
  })

  it('creates a managed mirror and run workspace for explicit repo mode', async () => {
    const sourceRepo = await createFixture(
      'notionflow-workspace-runtime-source-',
    )
    await initGitRepo(sourceRepo)
    await mkdir(path.join(sourceRepo, 'packages', 'api'), {recursive: true})
    await writeFile(
      path.join(sourceRepo, 'packages', 'api', 'service.txt'),
      'main branch\n',
      'utf8',
    )
    await commitAll(sourceRepo, 'initial source repo')
    await runGit(['checkout', '-b', 'feature/demo'], sourceRepo)
    await writeFile(
      path.join(sourceRepo, 'packages', 'api', 'service.txt'),
      'feature branch\n',
      'utf8',
    )
    const featureHead = await commitAll(sourceRepo, 'feature branch update')

    const projectRoot = await createFixture(
      'notionflow-workspace-runtime-explicit-',
    )
    const configPath = path.join(projectRoot, 'notionflow.config.ts')
    await writeFile(
      configPath,
      [
        'export default {',
        '  workspace: {',
        `    repo: ${JSON.stringify(sourceRepo)},`,
        '    ref: "feature/demo",',
        '    cwd: "packages/api",',
        '  },',
        '};',
        '',
      ].join('\n'),
      'utf8',
    )

    const config = await loadProjectConfig(configPath)
    const workspace = await resolveWorkspaceConfig({
      config,
      projectRoot,
      configPath,
    })
    const runtimePaths = resolveRuntimePaths(projectRoot)

    const provisioned = await provisionRunWorkspace({
      paths: runtimePaths,
      projectRoot,
      workspace,
      runId: 'run-explicit-1',
    })

    expect(provisioned.root).toBe(
      path.join(runtimePaths.workspacesDir, 'run-explicit-1'),
    )
    expect(provisioned.cwd).toBe(path.join(provisioned.root, 'packages', 'api'))
    expect(provisioned.relativeCwd).toBe(path.join('packages', 'api'))
    expect(provisioned.repo).toBe(await realpath(sourceRepo))
    expect(provisioned.requestedRef).toBe('feature/demo')
    expect(provisioned.ref).toBe(featureHead)
    expect(
      await readFile(path.join(provisioned.cwd, 'service.txt'), 'utf8'),
    ).toBe('feature branch\n')
  })

  it('validates project workspaces without creating mirrors or run worktrees', async () => {
    const repoRoot = await createFixture(
      'notionflow-workspace-runtime-validate-project-',
    )
    await initGitRepo(repoRoot)

    const projectRoot = path.join(repoRoot, 'packages', 'app')
    await mkdir(path.join(projectRoot, 'docs'), {recursive: true})
    await writeFile(
      path.join(projectRoot, 'docs', 'guide.md'),
      'workspace validation\n',
      'utf8',
    )
    const configPath = path.join(projectRoot, 'notionflow.config.ts')
    await writeFile(
      configPath,
      [
        'export default {',
        '  workspace: {',
        '    cwd: "docs",',
        '  },',
        '};',
        '',
      ].join('\n'),
      'utf8',
    )
    const head = await commitAll(repoRoot, 'workspace validation project')

    const config = await loadProjectConfig(configPath)
    const workspace = await resolveWorkspaceConfig({
      config,
      projectRoot,
      configPath,
    })
    const runtimePaths = resolveRuntimePaths(projectRoot)

    await expect(
      validateWorkspaceSetup({
        projectRoot,
        workspace,
      }),
    ).resolves.toEqual({
      source: 'project',
      repo: await realpath(repoRoot),
      repoKind: 'local',
      requestedRef: 'HEAD',
      ref: head,
      relativeCwd: 'packages/app/docs',
    })

    expect(await pathExists(runtimePaths.workspaceMirrorsDir)).toBe(false)
    expect(await pathExists(runtimePaths.workspaceManifestsDir)).toBe(false)
    expect(await pathExists(runtimePaths.workspacesDir)).toBe(false)
  })

  it('validates explicit remote repo shorthands without provisioning a checkout', async () => {
    const sourceRepo = await createFixture(
      'notionflow-workspace-runtime-validate-remote-source-',
    )
    await initGitRepo(sourceRepo)
    await mkdir(path.join(sourceRepo, 'packages', 'api'), {recursive: true})
    await writeFile(
      path.join(sourceRepo, 'packages', 'api', 'service.txt'),
      'remote validation\n',
      'utf8',
    )
    const head = await commitAll(sourceRepo, 'workspace validation remote')

    const projectRoot = await createFixture(
      'notionflow-workspace-runtime-validate-remote-project-',
    )
    const workspace = createExplicitWorkspaceConfig(
      `file://${await realpath(sourceRepo)}`,
    )

    await expect(
      validateWorkspaceSetup({
        projectRoot,
        workspace: {
          ...workspace,
          cwd: 'packages/api',
        },
      }),
    ).resolves.toEqual({
      source: 'repo',
      repo: `file://${await realpath(sourceRepo)}`,
      repoKind: 'remote',
      requestedRef: 'HEAD',
      ref: head,
      relativeCwd: 'packages/api',
    })
  })

  it('fails fast when the configured explicit repo is not a git repository', async () => {
    const projectRoot = await createFixture(
      'notionflow-workspace-runtime-invalid-repo-',
    )
    const invalidRepo = path.join(projectRoot, 'not-a-repo')
    await mkdir(invalidRepo, {recursive: true})

    const runtimePaths = resolveRuntimePaths(projectRoot)
    const workspace = createExplicitWorkspaceConfig(invalidRepo)

    await expect(
      provisionRunWorkspace({
        paths: runtimePaths,
        projectRoot,
        workspace,
        runId: 'run-invalid-repo',
      }),
    ).rejects.toThrowError(/Workspace source is not a readable git repo/)

    await expect(
      provisionRunWorkspace({
        paths: runtimePaths,
        projectRoot,
        workspace,
        runId: 'run-invalid-repo',
      }),
    ).rejects.toThrowError(
      new RegExp(invalidRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    )
  })

  it('fails fast when the configured ref cannot be resolved from the managed mirror', async () => {
    const sourceRepo = await createFixture(
      'notionflow-workspace-runtime-invalid-ref-source-',
    )
    await initGitRepo(sourceRepo)
    await writeFile(path.join(sourceRepo, 'README.md'), 'root\n', 'utf8')
    await commitAll(sourceRepo, 'initial source repo')

    const projectRoot = await createFixture(
      'notionflow-workspace-runtime-invalid-ref-project-',
    )
    const runtimePaths = resolveRuntimePaths(projectRoot)

    await expect(
      provisionRunWorkspace({
        paths: runtimePaths,
        projectRoot,
        workspace: {
          ...createExplicitWorkspaceConfig(sourceRepo),
          ref: 'missing-ref',
        },
        runId: 'run-invalid-ref',
      }),
    ).rejects.toThrowError(/Failed to resolve workspace ref `missing-ref`/)
  })

  it('removes run worktrees and manifests when cleanup is requested', async () => {
    const repoRoot = await createFixture(
      'notionflow-workspace-runtime-cleanup-project-',
    )
    await initGitRepo(repoRoot)

    const projectRoot = path.join(repoRoot, 'packages', 'app')
    await mkdir(projectRoot, {recursive: true})
    const configPath = path.join(projectRoot, 'notionflow.config.ts')
    await writeFile(configPath, 'export default {};\n', 'utf8')
    await writeFile(path.join(projectRoot, 'README.md'), 'cleanup me\n', 'utf8')
    await commitAll(repoRoot, 'initial cleanup project')

    const config = await loadProjectConfig(configPath)
    const workspace = await resolveWorkspaceConfig({
      config,
      projectRoot,
      configPath,
    })
    const runtimePaths = resolveRuntimePaths(projectRoot)

    const provisioned = await provisionRunWorkspace({
      paths: runtimePaths,
      projectRoot,
      workspace,
      runId: 'run-cleanup-1',
    })

    await expect(
      cleanupRunWorkspace({
        paths: runtimePaths,
        projectRoot,
        runId: 'run-cleanup-1',
      }),
    ).resolves.toBe(true)

    expect(await pathExists(provisioned.root)).toBe(false)
    expect(await pathExists(provisioned.manifestPath)).toBe(false)
    await expect(
      runGit(
        [
          '--git-dir',
          provisioned.mirrorPath,
          'worktree',
          'list',
          '--porcelain',
        ],
        projectRoot,
      ),
    ).resolves.not.toContain(path.resolve(provisioned.root))
  })

  it('prunes stale worktree registrations and orphaned workspace directories', async () => {
    const repoRoot = await createFixture(
      'notionflow-workspace-runtime-prune-project-',
    )
    await initGitRepo(repoRoot)

    const projectRoot = path.join(repoRoot, 'packages', 'app')
    await mkdir(projectRoot, {recursive: true})
    const configPath = path.join(projectRoot, 'notionflow.config.ts')
    await writeFile(configPath, 'export default {};\n', 'utf8')
    await writeFile(path.join(projectRoot, 'README.md'), 'prune me\n', 'utf8')
    await commitAll(repoRoot, 'initial prune project')

    const config = await loadProjectConfig(configPath)
    const workspace = await resolveWorkspaceConfig({
      config,
      projectRoot,
      configPath,
    })
    const runtimePaths = resolveRuntimePaths(projectRoot)

    const provisioned = await provisionRunWorkspace({
      paths: runtimePaths,
      projectRoot,
      workspace,
      runId: 'run-prune-1',
    })
    const orphanWorkspacePath = path.join(
      runtimePaths.workspacesDir,
      'orphan-run',
    )
    await mkdir(orphanWorkspacePath, {recursive: true})
    await writeFile(
      path.join(orphanWorkspacePath, 'temp.txt'),
      'orphan\n',
      'utf8',
    )

    await rm(provisioned.root, {recursive: true, force: true})
    await expect(
      runGit(
        [
          '--git-dir',
          provisioned.mirrorPath,
          'worktree',
          'list',
          '--porcelain',
        ],
        projectRoot,
      ),
    ).resolves.toContain(path.resolve(provisioned.root))

    await pruneWorkspaceArtifacts({
      paths: runtimePaths,
      projectRoot,
    })

    await expect(
      runGit(
        [
          '--git-dir',
          provisioned.mirrorPath,
          'worktree',
          'list',
          '--porcelain',
        ],
        projectRoot,
      ),
    ).resolves.not.toContain(path.resolve(provisioned.root))
    expect(await pathExists(orphanWorkspacePath)).toBe(false)
  })
})

async function createFixture(prefix: string): Promise<string> {
  const fixturePath = await mkdtemp(path.join(os.tmpdir(), prefix))
  fixtures.push(fixturePath)
  return fixturePath
}

function createExplicitWorkspaceConfig(repo: string): ResolvedWorkspaceConfig {
  return {
    source: 'repo',
    repo:
      /^[a-z][a-z\d+.-]*:\/\//i.test(repo) ||
      /^[^@/\s]+@[^:/\s]+:.+$/.test(repo)
        ? repo
        : path.resolve(repo),
    ref: 'HEAD',
    cwd: '.',
    cleanup: 'on-success',
  }
}

async function initGitRepo(repoRoot: string): Promise<void> {
  await runGit(['init'], repoRoot)
  await runGit(['config', 'user.name', 'NotionFlow Test'], repoRoot)
  await runGit(['config', 'user.email', 'notionflow@example.com'], repoRoot)
}

async function commitAll(repoRoot: string, message: string): Promise<string> {
  await runGit(['add', '.'], repoRoot)
  await runGit(['commit', '-m', message], repoRoot)
  return runGit(['rev-parse', '--verify', 'HEAD'], repoRoot)
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

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }

    throw error
  }
}
