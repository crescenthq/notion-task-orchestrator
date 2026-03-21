import {defineConfig} from 'notionflow'

export default defineConfig({
  factories: [
    './pipes/intent.ts',
    './pipes/expressive-primitives.ts',
    './pipes/magic-8.ts',
    './pipes/would-you-rather.ts',
    './pipes/shared-helper-demo.ts',
  ],
})
