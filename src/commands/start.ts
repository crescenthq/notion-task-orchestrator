import {defineCommand} from 'citty'
import {launchStartSession} from '../start/runtime'

type StartArgs = {
  pipe?: string
  config?: string
  intervalMs?: string
  refreshMs?: string
  limit?: string
  maxTransitionsPerTick?: string
  runConcurrency?: string
  leaseMs?: string
  leaseMode?: string
  workerId?: string
}

type StartSessionArgs = {
  pipe?: string
  configPath?: string
  intervalMs?: string
  refreshMs?: string
  limit?: string
  maxTransitionsPerTick?: string
  runConcurrency?: string
  leaseMs?: string
  leaseMode?: string
  workerId?: string
}

export const startCmd = defineCommand({
  meta: {
    name: 'start',
    description:
      '[common] Start the interactive operator dashboard and worker loop',
  },
  args: {
    pipe: {type: 'string', required: false},
    config: {type: 'string', required: false},
    intervalMs: {type: 'string', required: false, alias: 'interval-ms'},
    refreshMs: {type: 'string', required: false, alias: 'refresh-ms'},
    limit: {type: 'string', required: false},
    maxTransitionsPerTick: {
      type: 'string',
      required: false,
      alias: 'max-transitions-per-tick',
    },
    runConcurrency: {
      type: 'string',
      required: false,
      alias: 'run-concurrency',
    },
    leaseMs: {type: 'string', required: false, alias: 'lease-ms'},
    leaseMode: {type: 'string', required: false, alias: 'lease-mode'},
    workerId: {type: 'string', required: false, alias: 'worker-id'},
  },
  async run({args}) {
    await launchStartSession(normalizeStartArgs(args as StartArgs))
  },
})

function normalizeStartArgs(args: StartArgs): StartSessionArgs {
  return {
    pipe: args.pipe ? String(args.pipe) : undefined,
    configPath: args.config ? String(args.config) : undefined,
    intervalMs: args.intervalMs ? String(args.intervalMs) : undefined,
    refreshMs: args.refreshMs ? String(args.refreshMs) : undefined,
    limit: args.limit ? String(args.limit) : undefined,
    maxTransitionsPerTick: args.maxTransitionsPerTick
      ? String(args.maxTransitionsPerTick)
      : undefined,
    runConcurrency: args.runConcurrency
      ? String(args.runConcurrency)
      : undefined,
    leaseMs: args.leaseMs ? String(args.leaseMs) : undefined,
    leaseMode: args.leaseMode ? String(args.leaseMode) : undefined,
    workerId: args.workerId ? String(args.workerId) : undefined,
  }
}
