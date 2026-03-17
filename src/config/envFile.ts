import {readFile, writeFile} from 'node:fs/promises'

export async function upsertEnvVar(
  envPath: string,
  key: string,
  value: string,
): Promise<void> {
  let current = ''

  try {
    current = await readFile(envPath, 'utf8')
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error
    }
  }

  const nextEntry = `${key}=${value}`
  const lines = current.length > 0 ? current.split(/\r?\n/) : []
  let replaced = false
  const nextLines = lines.map(line => {
    if (!line.startsWith(`${key}=`)) return line
    replaced = true
    return nextEntry
  })

  if (!replaced) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== '') {
      nextLines.push('')
    }
    nextLines.push(nextEntry)
  }

  const nextContent = `${nextLines
    .filter((_, index, all) => {
      if (index !== all.length - 1) return true
      return all[index] !== ''
    })
    .join('\n')}\n`
  await writeFile(envPath, nextContent, 'utf8')
}
