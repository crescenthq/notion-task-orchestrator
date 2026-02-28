import {defineCommand} from 'citty'
import {notionCmd} from './notion'

export const integrationsCmd = defineCommand({
  meta: {
    name: 'integrations',
    description: '[integration] Manage integration providers',
  },
  subCommands: {
    notion: notionCmd,
  },
})
