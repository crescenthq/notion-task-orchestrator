import {defineConfig} from 'drizzle-kit'
import {paths} from './src/config/paths'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: `file:${paths.db}`,
  },
})
