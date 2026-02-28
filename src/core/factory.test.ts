import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {loadFactoryFromPath} from './factory'

const createdDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'notionflow-factory-test-'))
  createdDirs.push(dir)
  return dir
}

describe('loadFactoryFromPath', () => {
  afterEach(async () => {
    for (const dir of createdDirs.splice(0, createdDirs.length)) {
      await rm(dir, {recursive: true, force: true})
    }
  })

  it('loads a module with default exported factory object', async () => {
    const dir = await createTempDir()
    const filePath = path.join(dir, 'good-factory.mjs')

    await writeFile(
      filePath,
      `const localAgent = async () => ({ status: "done", data: { ok: true } });\n\nexport default {\n  id: "good-factory",\n  start: "start",\n  states: {\n    start: { type: "action", agent: localAgent, on: { done: "done", failed: "failed" } },\n    done: { type: "done" },\n    failed: { type: "failed" }\n  }\n};\n`,
      'utf8',
    )

    const loaded = await loadFactoryFromPath(filePath)
    expect(loaded.definition.id).toBe('good-factory')
  })

  it('rejects imported runtime function references', async () => {
    const dir = await createTempDir()
    const helperPath = path.join(dir, 'helper.mjs')
    const filePath = path.join(dir, 'bad-factory.mjs')

    await writeFile(
      helperPath,
      `export async function importedAgent() { return { status: "done" }; }\n`,
      'utf8',
    )
    await writeFile(
      filePath,
      `import { importedAgent } from "./helper.mjs";\n\nexport default {\n  id: "bad-factory",\n  start: "start",\n  states: {\n    start: { type: "action", agent: importedAgent, on: { done: "done", failed: "failed" } },\n    done: { type: "done" },\n    failed: { type: "failed" }\n  }\n};\n`,
      'utf8',
    )

    await expect(loadFactoryFromPath(filePath)).rejects.toThrow(
      /Imported function `importedAgent` cannot be used as runtime `agent`/,
    )
  })
})
