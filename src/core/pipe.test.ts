import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {isPipeModuleDefinition, loadPipeFromPath} from './pipe'

const createdDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'notionflow-factory-test-'))
  createdDirs.push(dir)
  return dir
}

describe('loadPipeFromPath', () => {
  afterEach(async () => {
    for (const dir of createdDirs.splice(0, createdDirs.length)) {
      await rm(dir, {recursive: true, force: true})
    }
  })

  it('loads a module with default exported definePipe pipe object', async () => {
    const dir = await createTempDir()
    const filePath = path.join(dir, 'pipe-factory.mjs')

    await writeFile(
      filePath,
      `export default {\n  id: "pipe-factory",\n  initial: { visits: 0 },\n  run: async ({ ctx }) => ({ ...ctx, visits: Number(ctx.visits ?? 0) + 1 })\n};\n`,
      'utf8',
    )

    const loaded = await loadPipeFromPath(filePath)
    expect(loaded.definition.id).toBe('pipe-factory')
    expect(isPipeModuleDefinition(loaded.definition)).toBe(true)
  })

  it('loads a module with optional pipe name metadata', async () => {
    const dir = await createTempDir()
    const filePath = path.join(dir, 'named-factory.mjs')

    await writeFile(
      filePath,
      `export default {\n  id: "named-factory",\n  name: "Named Factory",\n  initial: { visits: 0 },\n  run: async ({ ctx }) => ({ ...ctx, visits: Number(ctx.visits ?? 0) + 1 })\n};\n`,
      'utf8',
    )

    const loaded = await loadPipeFromPath(filePath)
    expect(loaded.definition.name).toBe('Named Factory')
    expect(isPipeModuleDefinition(loaded.definition)).toBe(true)
  })

  it('rejects modules that do not export a definePipe pipe object shape', async () => {
    const dir = await createTempDir()
    const filePath = path.join(dir, 'legacy-factory.mjs')

    await writeFile(
      filePath,
      `export default {\n  id: "legacy-factory",\n  start: "start",\n  states: {\n    start: { type: "action", agent: async () => ({ status: "done" }), on: { done: "done", failed: "failed" } },\n    done: { type: "done" },\n    failed: { type: "failed" }\n  }\n};\n`,
      'utf8',
    )

    await expect(loadPipeFromPath(filePath)).rejects.toThrow(
      /Module must export a definePipe pipe with shape \{ id, initial, run \}/,
    )
  })

  it('rejects modules without a default export object', async () => {
    const dir = await createTempDir()
    const filePath = path.join(dir, 'missing-default.mjs')

    await writeFile(filePath, `export const x = 1;\n`, 'utf8')

    await expect(loadPipeFromPath(filePath)).rejects.toThrow(
      /Module must export a pipe object as default export/,
    )
  })
})
