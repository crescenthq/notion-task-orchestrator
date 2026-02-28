#!/usr/bin/env node
import {defineCommand, runMain} from 'citty'
import {doctorCmd} from './commands/doctor'
import {factoryCmd} from './commands/factory'
import {initCmd} from './commands/init'
import {integrationsCmd} from './commands/integrations'
import {runCmd} from './commands/run'
import {statusCmd} from './commands/status'
import {tickCmd} from './commands/tick'

const main = defineCommand({
  meta: {
    name: 'notionflow',
    description: 'Library-first, project-local orchestration CLI',
    version: '0.1.0',
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
