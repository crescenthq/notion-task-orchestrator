import {mkdtemp, readdir, rm, stat} from 'node:fs/promises'
import type {Dirent} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type FileEntry = {
  mtimeMs: number
  size: number
}

export type FilesystemSnapshot = Map<string, FileEntry>

export type TempProjectFixture = {
  projectDir: string
  cleanup: () => Promise<void>
}

const GLOBAL_NOTIONFLOW_DIR = path.join(os.homedir(), '.config', 'notionflow')

export async function createTempProjectFixture(
  prefix = 'notionflow-e2e-',
): Promise<TempProjectFixture> {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), prefix))
  return {
    projectDir,
    cleanup: async () => {
      await rm(projectDir, {recursive: true, force: true})
    },
  }
}

export async function snapshotGlobalNotionflowWrites(): Promise<FilesystemSnapshot> {
  return snapshotFilesystemTree(GLOBAL_NOTIONFLOW_DIR)
}

export function assertNoNewGlobalNotionflowWrites(
  before: FilesystemSnapshot,
  after: FilesystemSnapshot,
): void {
  const created: string[] = []
  const modified: string[] = []

  for (const [entryPath, afterMeta] of after.entries()) {
    const beforeMeta = before.get(entryPath)
    if (!beforeMeta) {
      created.push(entryPath)
      continue
    }

    if (
      beforeMeta.mtimeMs !== afterMeta.mtimeMs ||
      beforeMeta.size !== afterMeta.size
    ) {
      modified.push(entryPath)
    }
  }

  if (created.length === 0 && modified.length === 0) {
    return
  }

  const detailLines = [
    ...created.map(entry => `created: ${entry}`),
    ...modified.map(entry => `modified: ${entry}`),
  ]

  throw new Error(
    [
      `Detected writes under ${GLOBAL_NOTIONFLOW_DIR} during E2E execution.`,
      ...detailLines,
    ].join('\n'),
  )
}

async function snapshotFilesystemTree(
  rootDir: string,
): Promise<FilesystemSnapshot> {
  const snapshot: FilesystemSnapshot = new Map()
  await walk(rootDir, snapshot, rootDir)
  return snapshot
}

async function walk(
  currentDir: string,
  snapshot: FilesystemSnapshot,
  rootDir: string,
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(currentDir, {withFileTypes: true})
  } catch {
    return
  }

  for (const entry of entries) {
    const absPath = path.join(currentDir, entry.name)
    const relPath = path.relative(rootDir, absPath)

    if (entry.isDirectory()) {
      snapshot.set(`${relPath}/`, {mtimeMs: 0, size: 0})
      await walk(absPath, snapshot, rootDir)
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    const fileStat = await stat(absPath)
    snapshot.set(relPath, {mtimeMs: fileStat.mtimeMs, size: fileStat.size})
  }
}
