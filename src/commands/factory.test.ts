import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {factoryCmd} from './factory'

const tempDirs: string[] = []
const originalCwd = process.cwd()

describe('factory command', () => {
  afterEach(async () => {
    process.chdir(originalCwd)
    vi.restoreAllMocks()

    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      await rm(dir, {recursive: true, force: true})
    }
  })

  it('creates an env-injected definePipe scaffold', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'notionflow-factory-'))
    tempDirs.push(projectRoot)

    await writeFile(
      path.join(projectRoot, 'notionflow.config.ts'),
      'export default { factories: [] }\n',
      'utf8',
    )
    process.chdir(projectRoot)

    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const createRun = (
      factoryCmd as unknown as {
        subCommands: {
          create: {
            run: (input: {args: Record<string, unknown>}) => Promise<void>
          }
        }
      }
    ).subCommands.create.run

    expect(createRun).toBeTypeOf('function')

    await createRun({
      args: {
        id: 'demo',
        skipNotionBoard: true,
      },
    })

    const scaffold = await readFile(path.join(projectRoot, 'factories', 'demo.ts'), 'utf8')
    expect(scaffold).toContain("import {definePipe, end, flow, step} from 'notionflow'")
    expect(scaffold).toContain('export default definePipe({')
    expect(scaffold).toContain('agents: {},')
    expect(scaffold).toContain('run: (_env) =>')
  })
})
