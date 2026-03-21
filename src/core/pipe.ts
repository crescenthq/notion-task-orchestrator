import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

export type PipeModuleDefinition = {
  id: string
  name?: string
  initial: unknown
  run: (input: unknown) => unknown
}

export type LoadedPipeDefinition = PipeModuleDefinition

export type LoadedPipeModule = {
  definition: LoadedPipeDefinition
  sourcePath: string
  sourceText: string
}

function formatDiagnostic(filePath: string, messages: string[]): Error {
  return new Error(
    [
      `Invalid pipe module: ${filePath}`,
      ...messages.map(message => `- ${message}`),
    ].join('\n'),
  )
}

function isPipeModuleDefinitionCandidate(
  value: unknown,
): value is PipeModuleDefinition {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === 'string' &&
    candidate.id.trim().length > 0 &&
    'initial' in candidate &&
    typeof candidate.run === 'function'
  )
}

export function isPipeModuleDefinition(
  definition: unknown,
): definition is PipeModuleDefinition {
  return isPipeModuleDefinitionCandidate(definition)
}

export async function loadPipeFromPath(
  inputPath: string,
): Promise<LoadedPipeModule> {
  const sourcePath = path.resolve(inputPath)
  const sourceText = await readFile(sourcePath, 'utf8')

  const moduleUrl = pathToFileURL(sourcePath)
  moduleUrl.searchParams.set('nf', String(Date.now()))

  const mod = await import(moduleUrl.href)
  const maybePipe = (mod as {default?: unknown}).default

  if (!maybePipe || typeof maybePipe !== 'object') {
    throw formatDiagnostic(sourcePath, [
      'Module must export a pipe object as default export',
    ])
  }

  if (!isPipeModuleDefinitionCandidate(maybePipe)) {
    throw formatDiagnostic(sourcePath, [
      'Module must export a definePipe pipe with shape { id, initial, run }',
    ])
  }

  return {
    definition: maybePipe,
    sourcePath,
    sourceText,
  }
}
