import {createClient} from '@libsql/client'
import {drizzle} from 'drizzle-orm/libsql'

export function openDatabase(dbPath: string) {
  const client = createClient({url: `file:${dbPath}`})
  return {client, db: drizzle(client)}
}
