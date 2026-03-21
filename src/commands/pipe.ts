import {mkdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {defineCommand} from 'citty'
import {openApp} from '../app/context'
import {workflows} from '../db/schema'
import {
  ProjectConfigResolutionError,
  resolveProjectConfig,
} from '../project/discoverConfig'

export const pipeCmd = defineCommand({
  meta: {name: 'pipe', description: '[advanced] Manage pipes'},
  subCommands: {
    create: defineCommand({
      meta: {
        name: 'create',
        description: 'Create a new TypeScript pipe scaffold',
      },
      args: {
        id: {type: 'string', required: true},
        config: {type: 'string', required: false},
      },
      async run({args}) {
        let resolvedProject
        try {
          resolvedProject = await resolveProjectConfig({
            startDir: process.cwd(),
            configPath: args.config ? String(args.config) : undefined,
          })
        } catch (error) {
          if (!(error instanceof ProjectConfigResolutionError)) {
            throw error
          }

          console.error(`[error] ${error.message}`)
          console.error(`Start directory: ${error.startDir}`)
          if (error.attemptedPath) {
            console.error(`Attempted config path: ${error.attemptedPath}`)
          }
          console.error(
            'Run `notionflow init` in your project root first, or pass --config <path>.',
          )
          process.exitCode = 1
          return
        }

        const id = String(args.id)
        const targetDir = path.join(resolvedProject.projectRoot, 'pipes')
        const targetPath = path.join(targetDir, `${id}.ts`)
        const template = `export default {\n  id: "${id}",\n  initial: {},\n  run: async ({ctx}) => ({...ctx, result: 'ok'}),\n}\n`
        await mkdir(targetDir, {recursive: true})
        await writeFile(targetPath, template, 'utf8')

        console.log(`Pipe scaffold created: ${id}`)
        console.log(`Path: ${targetPath}`)
      },
    }),
    list: defineCommand({
      meta: {name: 'list', description: 'List installed pipes'},
      async run() {
        const {db} = await openApp()
        const rows = await db.select().from(workflows)
        if (rows.length === 0) {
          console.log('No pipes configured')
          return
        }
        for (const row of rows) console.log(`${row.id}  v${row.version}`)
      },
    }),
  },
})
