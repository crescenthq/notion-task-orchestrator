import {defineCommand} from 'citty'
import {eq} from 'drizzle-orm'
import {openApp} from '../app/context'
import {tasks} from '../db/schema'

export const statusCmd = defineCommand({
  meta: {
    name: 'status',
    description: '[common] Show task status from local SQLite',
  },
  args: {
    task: {type: 'string', required: true},
  },
  async run({args}) {
    const {db} = await openApp()
    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.externalTaskId, String(args.task)))
    if (!task) {
      console.log('Task not found')
      return
    }
    console.log(JSON.stringify(task, null, 2))
  },
})
