import type {TaskHandle} from '../../src/pipe/canonical'

export function createMockTaskHandle(
  overrides: Partial<TaskHandle> & Pick<TaskHandle, 'id' | 'title'>,
): TaskHandle {
  return {
    id: overrides.id,
    title: overrides.title,
    readArtifact: overrides.readArtifact ?? (async () => ''),
    writeArtifact: overrides.writeArtifact ?? (async () => undefined),
    updateStatus: overrides.updateStatus ?? (async () => undefined),
    comment: overrides.comment ?? (async () => undefined),
  }
}
