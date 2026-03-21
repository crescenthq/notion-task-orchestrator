type JsonRecord = Record<string, unknown>

export const CHECKPOINT_VERSION = 1 as const

export type CheckpointSegment =
  | {k: 'flow'; at: number}
  | {k: 'decide'; branch: string}
  | {k: 'loop'; iter: number}

export type Checkpoint = {
  v: typeof CHECKPOINT_VERSION
  path: CheckpointSegment[]
}

export class CheckpointMismatchError extends Error {
  readonly code = 'checkpoint_mismatch'

  constructor(message: string) {
    super(message)
    this.name = 'CheckpointMismatchError'
  }
}

export type ParseCheckpointOptions = {
  location: string
  onInvalid?: 'throw' | 'return-undefined'
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null
}

function parseCheckpointSegment(value: unknown): CheckpointSegment | undefined {
  if (!isRecord(value) || typeof value.k !== 'string') {
    return undefined
  }

  if (value.k === 'flow') {
    if (!Number.isInteger(value.at) || Number(value.at) < 0) {
      return undefined
    }
    return {k: 'flow', at: Number(value.at)}
  }

  if (value.k === 'decide') {
    if (typeof value.branch !== 'string') {
      return undefined
    }
    return {k: 'decide', branch: value.branch}
  }

  if (value.k === 'loop') {
    if (!Number.isInteger(value.iter) || Number(value.iter) < 0) {
      return undefined
    }
    return {k: 'loop', iter: Number(value.iter)}
  }

  return undefined
}

export function parseCheckpoint(
  value: unknown,
  options: ParseCheckpointOptions,
): Checkpoint | undefined {
  const onInvalid = options.onInvalid ?? 'throw'
  const fail = (message: string): undefined => {
    if (onInvalid === 'return-undefined') {
      return undefined
    }
    throw new CheckpointMismatchError(message)
  }

  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) {
    return fail(`Malformed checkpoint at ${options.location}: expected object`)
  }
  if (value.v !== CHECKPOINT_VERSION) {
    return fail(
      `Unsupported checkpoint version at ${options.location}: ${String(value.v)}`,
    )
  }
  if (!Array.isArray(value.path)) {
    return fail(
      `Malformed checkpoint at ${options.location}: path must be an array`,
    )
  }

  const path: CheckpointSegment[] = []
  for (const [index, segmentValue] of value.path.entries()) {
    const segment = parseCheckpointSegment(segmentValue)
    if (!segment) {
      return fail(
        `Malformed checkpoint segment at ${options.location}[${index}]`,
      )
    }
    path.push(segment)
  }

  return {
    v: CHECKPOINT_VERSION,
    path,
  }
}

export function checkpointFromPath(
  path: CheckpointSegment[],
): Checkpoint | undefined {
  if (path.length === 0) return undefined
  return {
    v: CHECKPOINT_VERSION,
    path,
  }
}

export function prependCheckpointSegment(
  segment: CheckpointSegment,
  checkpoint: Checkpoint | undefined,
): Checkpoint {
  const path = checkpoint ? checkpoint.path : []
  return {
    v: CHECKPOINT_VERSION,
    path: [segment, ...path],
  }
}
