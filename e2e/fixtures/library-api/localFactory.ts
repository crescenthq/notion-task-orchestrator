import {decide, definePipe, end, flow} from 'notionflow'
import {chooseRoute, scoreTask} from './sharedHelpers'

export default definePipe({
  id: 'library-api-fixture',
  initial: {score: 0},
  run: flow(
    scoreTask,
    decide(
      chooseRoute,
      {
        done: end.done(),
        retry: flow(scoreTask, end.done()),
      },
    ),
  ),
})
