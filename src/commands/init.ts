import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {defineCommand} from 'citty'

const CONFIG_FILE = 'notionflow.config.ts'
const PIPES_DIR = 'pipes'
const RUNTIME_DIR = '.notionflow'
const GITIGNORE_FILE = '.gitignore'
const RUNTIME_GITIGNORE_ENTRY = '.notionflow/'

export const initCmd = defineCommand({
  meta: {
    name: 'init',
    description: '[common] Initialize a local NotionFlow project',
  },
  async run() {
    const projectRoot = process.cwd()
    const configPath = path.join(projectRoot, CONFIG_FILE)
    const pipesPath = path.join(projectRoot, PIPES_DIR)
    const runtimePath = path.join(projectRoot, RUNTIME_DIR)

    await mkdir(pipesPath, {recursive: true})
    await mkdir(runtimePath, {recursive: true})
    await writeFile(configPath, buildDefaultConfigTemplate(projectRoot), {
      encoding: 'utf8',
      flag: 'wx',
    }).catch(async error => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return
      }

      throw error
    })

    await ensureRuntimeDirGitIgnored(path.join(projectRoot, GITIGNORE_FILE))

    console.log('NotionFlow project initialized')
    console.log(`Project root: ${projectRoot}`)
    console.log(`Config: ${configPath}`)
  },
})

function buildDefaultConfigTemplate(projectRoot: string): string {
  return `import { defineConfig } from "notionflow";

export default defineConfig({
  name: ${JSON.stringify(defaultProjectName(projectRoot))},
});
`
}

function defaultProjectName(projectRoot: string): string {
  const baseName = path.basename(projectRoot).trim()
  if (!baseName) return 'NotionFlow'

  const parts = baseName
    .split(/[-_]+/)
    .map(part => part.trim())
    .filter(part => part.length > 0)

  if (parts.length === 0) return baseName
  return parts.map(part => part[0]?.toUpperCase() + part.slice(1)).join(' ')
}

async function ensureRuntimeDirGitIgnored(
  gitignorePath: string,
): Promise<void> {
  let existing = ''
  try {
    existing = await readFile(gitignorePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  const normalizedLines = existing
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && line !== RUNTIME_GITIGNORE_ENTRY)

  normalizedLines.push(RUNTIME_GITIGNORE_ENTRY)

  const uniqueLines = Array.from(new Set(normalizedLines))
  const nextContent = `${uniqueLines.join('\n')}\n`
  await writeFile(gitignorePath, nextContent, 'utf8')
}
