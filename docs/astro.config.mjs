// @ts-check
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  site: 'https://crescenthq.github.io',
  base: '/notion-task-orchestrator',
  integrations: [
    starlight({
      title: 'NotionFlow Docs',
      description:
        'Comprehensive documentation for NotionFlow, an agent-agnostic workflow orchestrator for Notion.',
      editLink: {
        baseUrl:
          'https://github.com/crescenthq/notion-task-orchestrator/edit/main/docs',
      },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/crescenthq/notion-task-orchestrator',
        },
      ],
      sidebar: [
        { label: 'Home', slug: 'index' },
        {
          label: 'Guides',
          items: [{ slug: 'guides/factory-authoring' }],
        },
        {
          label: 'Reference',
          items: [
            { slug: 'reference/cli-reference' },
            { slug: 'reference/definepipe-v1-api-contract' },
            { slug: 'reference/architecture' },
          ],
        },
      ],
    }),
  ],
})
