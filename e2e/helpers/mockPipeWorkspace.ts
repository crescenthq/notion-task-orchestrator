import type {PipeWorkspace} from '../../src/pipe/canonical'

export const mockPipeWorkspace: PipeWorkspace = {
  root: '/tmp/pipes-workspace',
  cwd: '/tmp/pipes-workspace/app',
  ref: 'deadbeef',
  source: {
    mode: 'project',
    repo: '/tmp/pipes-source',
    requestedRef: 'HEAD',
  },
}
