import type {PipeWorkspace} from '../../src/pipe/canonical'

export const mockPipeWorkspace: PipeWorkspace = {
  root: '/tmp/notionflow-workspace',
  cwd: '/tmp/notionflow-workspace/app',
  ref: 'deadbeef',
  source: {
    mode: 'project',
    repo: '/tmp/notionflow-source',
    requestedRef: 'HEAD',
  },
}
