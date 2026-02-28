import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

export type PipeFactoryDefinition = {
  id: string
  initial: unknown
  run: (input: unknown) => unknown
}

export type LoadedFactoryDefinition = PipeFactoryDefinition

export type LoadedFactoryModule = {
  definition: LoadedFactoryDefinition
  sourcePath: string
  sourceText: string
}

function formatDiagnostic(filePath: string, messages: string[]): Error {
  return new Error(
    [
      `Invalid factory module: ${filePath}`,
      ...messages.map(message => `- ${message}`),
    ].join('\n'),
  )
}

function isPipeFactoryDefinitionCandidate(
  value: unknown,
): value is PipeFactoryDefinition {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === 'string' &&
    candidate.id.trim().length > 0 &&
    'initial' in candidate &&
    typeof candidate.run === 'function'
  )
}

export function isPipeFactoryDefinition(
  definition: unknown,
): definition is PipeFactoryDefinition {
  return isPipeFactoryDefinitionCandidate(definition)
}

export async function loadFactoryFromPath(
  inputPath: string,
): Promise<LoadedFactoryModule> {
  const sourcePath = path.resolve(inputPath)
  const sourceText = await readFile(sourcePath, 'utf8')

  const moduleUrl = pathToFileURL(sourcePath)
  moduleUrl.searchParams.set('nf', String(Date.now()))

  const mod = await import(moduleUrl.href)
  const maybeFactory = (mod as {default?: unknown}).default

  if (!maybeFactory || typeof maybeFactory !== 'object') {
    throw formatDiagnostic(sourcePath, [
      'Module must export a factory object as default export',
    ])
  }

  if (!isPipeFactoryDefinitionCandidate(maybeFactory)) {
    throw formatDiagnostic(sourcePath, [
      'Module must export a definePipe factory with shape { id, initial, run }',
    ])
  }

  return {
    definition: maybeFactory,
    sourcePath,
    sourceText,
  }
}
