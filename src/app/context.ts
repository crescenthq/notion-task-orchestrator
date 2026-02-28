import {appendFile, mkdir, writeFile} from 'node:fs/promises'
import {type RuntimePaths, resolveRuntimePaths} from '../config/paths'
import {bootstrapSchema, ensureDbDirectory} from '../db/bootstrap'
import {openDatabase} from '../db/client'
import {resolveProjectConfig} from '../project/discoverConfig'

export function nowIso(): string {
  return new Date().toISOString()
}

export type OpenAppOptions = {
  projectRoot?: string
  configPath?: string
  startDir?: string
}

export async function openApp(options: OpenAppOptions = {}) {
  const runtimePaths = await resolveAppRuntimePaths(options)

  await ensureDbDirectory(runtimePaths.db)
  await mkdir(runtimePaths.agentsDir, {recursive: true})
  await mkdir(runtimePaths.workflowsDir, {recursive: true})
  await touchRuntimeLogFiles(runtimePaths)

  const {db, client} = openDatabase(runtimePaths.db)
  await bootstrapSchema(client)

  await appendFile(
    runtimePaths.runtimeLog,
    `${nowIso()} openApp initialized\n`,
    'utf8',
  )

  return {db, client, paths: runtimePaths}
}

async function resolveAppRuntimePaths(
  options: OpenAppOptions,
): Promise<RuntimePaths> {
  if (options.projectRoot && options.projectRoot.trim().length > 0) {
    return resolveRuntimePaths(options.projectRoot)
  }

  if (
    process.env.NOTIONFLOW_PROJECT_ROOT &&
    process.env.NOTIONFLOW_PROJECT_ROOT.trim().length > 0
  ) {
    return resolveRuntimePaths(process.env.NOTIONFLOW_PROJECT_ROOT)
  }

  const resolvedProject = await resolveProjectConfig({
    startDir: options.startDir ?? process.cwd(),
    configPath: options.configPath,
  })
  return resolveRuntimePaths(resolvedProject.projectRoot)
}

async function touchRuntimeLogFiles(paths: RuntimePaths): Promise<void> {
  await writeFile(paths.runtimeLog, '', {flag: 'a'})
  await writeFile(paths.errorsLog, '', {flag: 'a'})
}
