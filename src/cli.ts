#!/usr/bin/env node
import {bootstrapRuntimeEnv, inferConfigPathFromArgv} from './config/envBootstrap'

await bootstrapRuntimeEnv({configPath: inferConfigPathFromArgv(process.argv) ?? undefined})

const {defineCommand, runMain} = await import('citty')
const {doctorCmd} = await import('./commands/doctor')
const {factoryCmd} = await import('./commands/factory')
const {initCmd} = await import('./commands/init')
const {integrationsCmd} = await import('./commands/integrations')
const {runCmd} = await import('./commands/run')
const {statusCmd} = await import('./commands/status')
const {tickCmd} = await import('./commands/tick')

const main = defineCommand({
  meta: {
    name: 'notionflow',
    description: 'Library-first, project-local orchestration CLI',
    version: '0.1.0',
  },
  args: {
    envFile: {
      type: 'string',
      required: false,
      description: 'Path to an environment file.',
      alias: 'env-file',
    },
  },
  subCommands: {
    init: initCmd,
    doctor: doctorCmd,
    tick: tickCmd,
    run: runCmd,
    status: statusCmd,
    factory: factoryCmd,
    integrations: integrationsCmd,
  },
})

runMain(main)
