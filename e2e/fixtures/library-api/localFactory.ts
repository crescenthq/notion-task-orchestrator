import {defineFactory} from 'notionflow'
import {chooseRoute, scoreReached, scoreTask} from './sharedHelpers'

export default defineFactory({
  id: 'library-api-fixture',
  start: 'work',
  context: {score: 0},
  guards: {
    reached: scoreReached,
  },
  states: {
    work: {
      type: 'action',
      agent: scoreTask,
      on: {done: 'route', failed: 'failed'},
    },
    route: {
      type: 'orchestrate',
      select: chooseRoute,
      on: {done: 'done', retry: 'work'},
    },
    done: {type: 'done'},
    failed: {type: 'failed'},
  },
})
