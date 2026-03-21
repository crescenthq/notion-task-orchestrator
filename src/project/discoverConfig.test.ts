import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {discoverProjectConfig, resolveProjectConfig} from './discoverConfig'

const fixtures: string[] = []

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixturePath = fixtures.pop()
    if (!fixturePath) continue
    await rm(fixturePath, {recursive: true, force: true})
  }
})

describe('discoverConfig', () => {
  it('prefers pipes.config.ts when both config filenames exist', async () => {
    const projectRoot = await createFixture('pipes-discover-config-both-')
    const startDir = path.join(projectRoot, 'nested', 'dir')
    await mkdir(startDir, {recursive: true})
    await writeFile(
      path.join(projectRoot, 'pipes.config.ts'),
      'export default {}\n',
    )
    await writeFile(
      path.join(projectRoot, 'notionflow.config.ts'),
      'export default {}\n',
    )

    await expect(discoverProjectConfig(startDir)).resolves.toEqual({
      projectRoot,
      configPath: path.join(projectRoot, 'pipes.config.ts'),
    })
  })

  it('falls back to notionflow.config.ts during discovery', async () => {
    const projectRoot = await createFixture('pipes-discover-config-legacy-')
    const startDir = path.join(projectRoot, 'nested', 'dir')
    await mkdir(startDir, {recursive: true})
    await writeFile(
      path.join(projectRoot, 'notionflow.config.ts'),
      'export default {}\n',
    )

    await expect(resolveProjectConfig({startDir})).resolves.toEqual({
      projectRoot,
      configPath: path.join(projectRoot, 'notionflow.config.ts'),
    })
  })
})

async function createFixture(prefix: string): Promise<string> {
  const fixturePath = await mkdtemp(path.join(os.tmpdir(), prefix))
  fixtures.push(fixturePath)
  return fixturePath
}
