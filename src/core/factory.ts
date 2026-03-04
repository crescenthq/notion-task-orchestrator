import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

export type PipeFactoryDefinition = {
  id: string
  name?: string
  initial: unknown
  agents: Record<string, unknown>
  run: (env: Record<string, unknown>) => (input: unknown) => unknown
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  const hasValidName =
    !('name' in candidate) ||
    candidate.name === undefined ||
    typeof candidate.name === 'string'
  const hasValidAgents =
    'agents' in candidate &&
    Boolean(candidate.agents) &&
    typeof candidate.agents === 'object' &&
    !Array.isArray(candidate.agents)
  return (
    typeof candidate.id === 'string' &&
    candidate.id.trim().length > 0 &&
    'initial' in candidate &&
    hasValidAgents &&
    typeof candidate.run === 'function' &&
    hasValidName
  )
}

function collectFactoryDefinitionValidationErrors(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['Default export must be an object']
  }

  const candidate = value as Record<string, unknown>
  const errors: string[] = []

  if (typeof candidate.id !== 'string' || candidate.id.trim().length === 0) {
    errors.push('`id` must be a non-empty string')
  }

  if (!('initial' in candidate)) {
    errors.push('`initial` is required')
  }

  if (!('agents' in candidate)) {
    errors.push('`agents` is required for env injection')
  } else if (
    !candidate.agents ||
    typeof candidate.agents !== 'object' ||
    Array.isArray(candidate.agents)
  ) {
    errors.push('`agents` must be an object map of declared dependencies')
  }

  if (typeof candidate.run !== 'function') {
    errors.push('`run` must be a function with signature `run(env)`')
  }

  if (
    'name' in candidate &&
    candidate.name !== undefined &&
    typeof candidate.name !== 'string'
  ) {
    errors.push('`name` must be a string when provided')
  }

  return errors
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

  if (!maybeFactory || typeof maybeFactory !== 'object' || Array.isArray(maybeFactory)) {
    throw formatDiagnostic(sourcePath, [
      'Module must export a factory object as default export',
    ])
  }

  const validationErrors = collectFactoryDefinitionValidationErrors(maybeFactory)
  if (validationErrors.length > 0) {
    throw formatDiagnostic(sourcePath, [
      'Module must export a definePipe factory with shape { id, initial, agents, run(env) }',
      ...validationErrors,
    ])
  }

  return {
    definition: maybeFactory,
    sourcePath,
    sourceText,
  }
}
