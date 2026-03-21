import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {
  loadDeclaredFactories,
  loadProjectConfig,
  resolveFactoryPaths,
} from './projectConfig'

const fixtures: string[] = []

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixturePath = fixtures.pop()
    if (!fixturePath) continue
    await rm(fixturePath, {recursive: true, force: true})
  }
})

describe('projectConfig', () => {
  it('loads an optional project name alongside default pipes discovery', async () => {
    const projectRoot = await createFixture('notionflow-project-config-name-')
    const pipesDir = path.join(projectRoot, 'pipes')
    await mkdir(pipesDir, {recursive: true})

    const localFactoryPath = path.join(pipesDir, 'named.mjs')
    const sharedHelperPath = path.join(pipesDir, 'shared', 'helper.mjs')
    await writeMinimalFactory(localFactoryPath, 'named-factory')
    await mkdir(path.dirname(sharedHelperPath), {recursive: true})
    await writeFile(
      sharedHelperPath,
      'export default { helper: true };\n',
      'utf8',
    )

    const configPath = path.join(projectRoot, 'notionflow.config.ts')
    await writeFile(configPath, `export default { name: "Asmara" };\n`, 'utf8')

    await expect(loadProjectConfig(configPath)).resolves.toEqual({
      name: 'Asmara',
      pipes: [],
    })

    const config = await loadProjectConfig(configPath)
    await expect(resolveFactoryPaths(config, projectRoot)).resolves.toEqual([
      localFactoryPath,
    ])

    const loaded = await loadDeclaredFactories({configPath, projectRoot})
    expect(loaded.map(entry => entry.definition.id)).toEqual(['named-factory'])
  })

  it('treats explicit empty pipes as default top-level discovery', async () => {
    const projectRoot = await createFixture(
      'notionflow-project-config-empty-pipes-',
    )
    const pipesDir = path.join(projectRoot, 'pipes')
    await mkdir(pipesDir, {recursive: true})

    const defaultFactoryPath = path.join(pipesDir, 'default.mjs')
    await writeMinimalFactory(defaultFactoryPath, 'default-factory')

    const configPath = path.join(projectRoot, 'notionflow.config.ts')
    await writeFile(configPath, `export default { pipes: [] };\n`, 'utf8')

    const config = await loadProjectConfig(configPath)
    await expect(resolveFactoryPaths(config, projectRoot)).resolves.toEqual([
      defaultFactoryPath,
    ])

    const loaded = await loadDeclaredFactories({configPath, projectRoot})
    expect(loaded.map(entry => entry.definition.id)).toEqual([
      'default-factory',
    ])
  })

  it('loads config and resolves declared directory and exact factory paths', async () => {
    const projectRoot = await createFixture('notionflow-project-config-')
    const pipesDir = path.join(projectRoot, 'pipes')
    await mkdir(pipesDir, {recursive: true})

    const localFactoryPath = path.join(pipesDir, 'local.mjs')
    const absoluteFactoryPath = path.join(projectRoot, 'absolute.mjs')
    await writeMinimalFactory(localFactoryPath, 'local-factory')
    await writeMinimalFactory(absoluteFactoryPath, 'absolute-factory')

    const configPath = path.join(projectRoot, 'notionflow.config.ts')
    await writeFile(
      configPath,
      `export default { pipes: ["./pipes", ${JSON.stringify(absoluteFactoryPath)}] };\n`,
      'utf8',
    )

    const config = await loadProjectConfig(configPath)
    const resolvedFactoryPaths = await resolveFactoryPaths(config, projectRoot)

    expect(resolvedFactoryPaths).toEqual([
      localFactoryPath,
      absoluteFactoryPath,
    ])

    const loaded = await loadDeclaredFactories({configPath, projectRoot})
    expect(loaded.map(entry => entry.definition.id)).toEqual([
      'local-factory',
      'absolute-factory',
    ])
  })

  it('treats declared directories as top-level scans', async () => {
    const projectRoot = await createFixture('notionflow-project-config-match-')
    const topLevelFactoryPath = path.join(projectRoot, 'factories', 'one.mjs')
    const nestedHelperPath = path.join(
      projectRoot,
      'factories',
      'shared',
      'helper.mjs',
    )
    await writeMinimalFactory(topLevelFactoryPath, 'alpha-factory')
    await mkdir(path.dirname(nestedHelperPath), {recursive: true})
    await writeFile(
      nestedHelperPath,
      'export default { helper: true };\n',
      'utf8',
    )

    const configPath = path.join(projectRoot, 'notionflow.config.ts')
    await writeFile(
      configPath,
      ['export default {', '  pipes: ["./factories"],', '};', ''].join('\n'),
      'utf8',
    )

    const config = await loadProjectConfig(configPath)
    await expect(resolveFactoryPaths(config, projectRoot)).resolves.toEqual([
      topLevelFactoryPath,
    ])

    const loaded = await loadDeclaredFactories({configPath, projectRoot})
    expect(loaded.map(entry => entry.definition.id)).toEqual(['alpha-factory'])
  })

  it('rejects configs that use the removed factories key', async () => {
    const projectRoot = await createFixture(
      'notionflow-project-config-factories-',
    )
    const configPath = path.join(projectRoot, 'notionflow.config.ts')
    await writeFile(
      configPath,
      `export default { factories: ["./pipes/legacy.mjs"] };\n`,
      'utf8',
    )

    await expect(loadProjectConfig(configPath)).rejects.toThrowError(
      /`factories` is no longer supported; use `pipes`/,
    )
  })

  it('does not fail when default pipes directory is absent and no pipes are declared', async () => {
    const projectRoot = await createFixture(
      'notionflow-project-config-default-missing-',
    )
    const configPath = path.join(projectRoot, 'notionflow.config.ts')
    await writeFile(configPath, `export default { name: "Asmara" };\n`, 'utf8')

    const config = await loadProjectConfig(configPath)
    await expect(resolveFactoryPaths(config, projectRoot)).resolves.toEqual([])
    await expect(
      loadDeclaredFactories({configPath, projectRoot}),
    ).resolves.toEqual([])
  })

  it('loads only config-declared factories and does not scan unlisted files', async () => {
    const projectRoot = await createFixture(
      'notionflow-project-config-declared-',
    )
    const pipesDir = path.join(projectRoot, 'pipes')
    await mkdir(pipesDir, {recursive: true})

    const listedFactoryPath = path.join(pipesDir, 'listed.mjs')
    const unlistedInvalidFactoryPath = path.join(
      pipesDir,
      'unlisted-invalid.mjs',
    )
    await writeMinimalFactory(listedFactoryPath, 'listed-factory')
    await writeFile(
      unlistedInvalidFactoryPath,
      "export default { not: 'a-factory' };\n",
      'utf8',
    )

    const configPath = path.join(projectRoot, 'notionflow.config.ts')
    await writeFile(
      configPath,
      `export default { pipes: ["./pipes/listed.mjs"] };\n`,
      'utf8',
    )

    const loaded = await loadDeclaredFactories({configPath, projectRoot})
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.definition.id).toBe('listed-factory')
  })

  it('fails with declared path context when a configured factory file is missing', async () => {
    const projectRoot = await createFixture(
      'notionflow-project-config-missing-',
    )
    const configPath = path.join(projectRoot, 'notionflow.config.ts')
    await writeFile(
      configPath,
      `export default { pipes: ["./pipes/missing.mjs"] };\n`,
      'utf8',
    )

    await expect(
      loadDeclaredFactories({configPath, projectRoot}),
    ).rejects.toThrowError(
      /Declared factory path does not exist: \.\/pipes\/missing\.mjs/,
    )

    await expect(
      loadDeclaredFactories({configPath, projectRoot}),
    ).rejects.toThrowError(/Resolved path:/)
  })

  it('fails fast when duplicate factory ids are declared across files', async () => {
    const projectRoot = await createFixture(
      'notionflow-project-config-duplicate-',
    )
    const pipesDir = path.join(projectRoot, 'pipes')
    await mkdir(pipesDir, {recursive: true})

    const firstFactoryPath = path.join(pipesDir, 'first.mjs')
    const secondFactoryPath = path.join(pipesDir, 'second.mjs')
    await writeMinimalFactory(firstFactoryPath, 'duplicate-factory')
    await writeMinimalFactory(secondFactoryPath, 'duplicate-factory')

    const configPath = path.join(projectRoot, 'notionflow.config.ts')
    await writeFile(
      configPath,
      `export default { pipes: ["./pipes/first.mjs", "./pipes/second.mjs"] };\n`,
      'utf8',
    )

    await expect(
      loadDeclaredFactories({configPath, projectRoot}),
    ).rejects.toThrowError(/Duplicate factory id detected: duplicate-factory/)

    await expect(
      loadDeclaredFactories({configPath, projectRoot}),
    ).rejects.toThrowError(/First resolved path:/)

    await expect(
      loadDeclaredFactories({configPath, projectRoot}),
    ).rejects.toThrowError(/Duplicate resolved path:/)
  })
})

async function createFixture(prefix: string): Promise<string> {
  const fixturePath = await mkdtemp(path.join(os.tmpdir(), prefix))
  fixtures.push(fixturePath)
  return fixturePath
}

async function writeMinimalFactory(
  targetPath: string,
  id: string,
): Promise<void> {
  await mkdir(path.dirname(targetPath), {recursive: true})
  await writeFile(
    targetPath,
    [
      'const run = async ({ctx}) => ({ ...ctx, ok: true });',
      '',
      'export default {',
      `  id: ${JSON.stringify(id)},`,
      '  initial: {},',
      '  run,',
      '};',
      '',
    ].join('\n'),
    'utf8',
  )
}
