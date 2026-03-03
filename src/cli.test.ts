import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {afterEach, describe, expect, it} from 'vitest'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const tsxLoader = path.join(
  repoRoot,
  'node_modules',
  'tsx',
  'dist',
  'loader.mjs',
)
const cliEntry = path.join(repoRoot, 'src', 'cli.ts')
const createdHomes: string[] = []
const createdProjects: string[] = []

function runCli(
  args: string[],
  home: string,
  env: NodeJS.ProcessEnv = {},
  cwd = repoRoot,
) {
  return spawnSync(
    process.execPath,
    ['--import', tsxLoader, cliEntry, ...args],
    {
      cwd,
      env: {...process.env, HOME: home, ...env},
      encoding: 'utf8',
    },
  )
}

describe('CLI bootstrap flow', () => {
  afterEach(() => {
    for (const dir of createdHomes.splice(0, createdHomes.length)) {
      rmSync(dir, {recursive: true, force: true})
    }
    for (const dir of createdProjects.splice(0, createdProjects.length)) {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('uses init as the canonical bootstrap and supports a basic orchestration command', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'notionflow-cli-test-'))
    const project = mkdtempSync(path.join(tmpdir(), 'notionflow-project-test-'))
    createdHomes.push(home)
    createdProjects.push(project)

    const init = runCli(['init'], home, {}, project)
    expect(init.status).toBe(0)
    expect(init.stdout).toContain('NotionFlow project initialized')

    const listFactories = runCli(['factory', 'list'], home, {}, project)
    expect(listFactories.status).toBe(0)
    expect(listFactories.stdout).toContain('No factories configured')
  })

  it('rejects removed legacy commands', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'notionflow-cli-test-'))
    createdHomes.push(home)

    for (const args of [['setup'], ['config', 'set'], ['board', 'list']]) {
      const run = runCli(args, home)
      const output = `${run.stdout}\n${run.stderr}`.toLowerCase()
      expect(run.status).not.toBe(0)
      expect(output).toContain('unknown command')
    }
  })

  it('routes Notion commands through integrations and rejects top-level notion', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'notionflow-cli-test-'))
    createdHomes.push(home)

    const legacy = runCli(['notion', 'sync'], home)
    const legacyOutput = `${legacy.stdout}\n${legacy.stderr}`.toLowerCase()
    expect(legacy.status).not.toBe(0)
    expect(legacyOutput).toContain('unknown command')

    const namespaced = runCli(['integrations', 'notion', 'sync'], home, {
      NOTION_API_TOKEN: 'test-token',
    })
    const namespacedOutput = `${namespaced.stdout}\n${namespaced.stderr}`
    expect(namespaced.status).not.toBe(0)
    expect(namespacedOutput).toContain('No Notion boards registered')
  })

  it('loads .env from the project resolved via --config', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'notionflow-cli-test-'))
    const project = mkdtempSync(path.join(tmpdir(), 'notionflow-project-test-'))
    createdHomes.push(home)
    createdProjects.push(project)

    const configPath = path.join(project, 'notionflow.config.ts')
    writeFileSync(configPath, 'export default { factories: [] };\n', 'utf8')
    writeFileSync(path.join(project, '.env'), 'NOTION_API_TOKEN=test-token\n', 'utf8')

    const run = runCli(
      ['integrations', 'notion', 'sync', '--config', configPath],
      home,
      {},
      repoRoot,
    )

    const output = `${run.stdout}\n${run.stderr}`
    expect(run.status).not.toBe(0)
    expect(output).toContain('No Notion boards registered')
    expect(output).not.toContain('NOTION_API_TOKEN is required')
  })
})
