type NotionUser = {
  object: string
  id: string
  name: string | null
  type: string
}

type NotionPage = {
  id: string
  properties: Record<string, any>
}

type NotionDatabase = {
  id: string
  data_sources?: Array<{id: string; name: string}>
  url?: string
}

type NotionSelectOption = {
  id?: string
  name: string
  color?: string
}

type NotionDataSourceProperty = {
  type: string
  select?: {options?: NotionSelectOption[]}
  rich_text?: Record<string, never>
  url?: Record<string, never>
}

export type NotionDatabaseConnection = {
  databaseId: string
  dataSourceId: string
  url: string | null
}

export type NotionQueryResult = {
  results: NotionPage[]
  hasMore: boolean
  nextCursor: string | null
}

export type NotionDataSource = {
  id: string
  database_parent?: {page_id?: string}
  properties: Record<string, NotionDataSourceProperty>
  url?: string
}

type NotionCreatePageResult = {
  id: string
  url?: string
}

type NotionBlock = {
  type: string
  [key: string]: any
}

type NotionPageMarkdown = {
  markdown?: string
}

type NotionCommentAuthor = {
  id?: string
  object?: string
  type?: string
}

type NotionCommentDisplayName = {
  type?: string
  resolved_name?: string | null
}

type NotionComment = {
  id: string
  created_time: string
  rich_text: Array<{plain_text?: string}>
  created_by?: NotionCommentAuthor
  display_name?: NotionCommentDisplayName
}

const NOTION_VERSION = '2025-09-03'

function notionHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  }
}

export async function notionWhoAmI(token: string): Promise<NotionUser> {
  const res = await fetch('https://api.notion.com/v1/users/me', {
    headers: notionHeaders(token),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Notion auth failed (${res.status}): ${text}`)
  }

  return (await res.json()) as NotionUser
}

export async function notionQueryDataSource(
  token: string,
  dataSourceId: string,
  input: {
    pageSize?: number
    startCursor?: string
    pipeId?: string
  } = {},
): Promise<NotionQueryResult> {
  const payload: Record<string, unknown> = {page_size: input.pageSize ?? 20}
  if (input.startCursor) payload.start_cursor = input.startCursor
  if (input.pipeId) {
    payload.filter = {
      property: 'Pipe',
      select: {equals: input.pipeId},
    }
  }

  const res = await fetch(
    `https://api.notion.com/v1/data_sources/${dataSourceId}/query`,
    {
      method: 'POST',
      headers: notionHeaders(token),
      body: JSON.stringify(payload),
    },
  )

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Notion query failed (${res.status}): ${text}`)
  }

  const body = (await res.json()) as {
    results?: NotionPage[]
    has_more?: boolean
    next_cursor?: string | null
  }

  return {
    results: body.results ?? [],
    hasMore: body.has_more ?? false,
    nextCursor: body.next_cursor ?? null,
  }
}

export async function notionQueryAllDataSourcePages(
  token: string,
  dataSourceId: string,
  input: {
    pageSize?: number
    pipeId?: string
  } = {},
): Promise<NotionPage[]> {
  const results: NotionPage[] = []
  let startCursor: string | undefined

  while (true) {
    const page = await notionQueryDataSource(token, dataSourceId, {
      pageSize: input.pageSize,
      startCursor,
      pipeId: input.pipeId,
    })
    results.push(...page.results)
    if (!page.hasMore) return results
    startCursor = page.nextCursor ?? undefined
  }
}

export async function notionCreateBoardDataSource(
  token: string,
  title: string,
  stepStatusOptions: Array<{name: string; color: string}> = [],
  pipeOptions: Array<{name: string; color: string}> = [],
  input: {parentPageId?: string | null} = {},
): Promise<NotionDatabaseConnection> {
  const createRes = await fetch('https://api.notion.com/v1/databases', {
    method: 'POST',
    headers: notionHeaders(token),
    body: JSON.stringify({
      parent: input.parentPageId
        ? {type: 'page_id', page_id: input.parentPageId}
        : {type: 'workspace', workspace: true},
      title: [{type: 'text', text: {content: title}}],
      initial_data_source: {
        properties: {
          Name: {title: {}},
        },
      },
    }),
  })

  if (!createRes.ok) {
    const text = await createRes.text()
    throw new Error(`Notion board create failed (${createRes.status}): ${text}`)
  }

  const database = (await createRes.json()) as NotionDatabase
  const dataSourceId = database.data_sources?.[0]?.id
  if (!dataSourceId)
    throw new Error(
      'Notion board create succeeded but no data source id was returned',
    )

  await notionEnsureBoardSchema(
    token,
    dataSourceId,
    stepStatusOptions,
    pipeOptions,
  )
  return {dataSourceId, databaseId: database.id, url: database.url ?? null}
}

export async function notionArchiveDatabase(
  token: string,
  databaseId: string,
): Promise<void> {
  const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
    method: 'PATCH',
    headers: notionHeaders(token),
    body: JSON.stringify({in_trash: true}),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Notion database archive failed (${res.status}): ${text}`)
  }
}

const STATE_OPTIONS = [
  {name: 'Queue', color: 'gray'},
  {name: 'In Progress', color: 'blue'},
  {name: 'Needs Input', color: 'orange'},
  {name: 'Done', color: 'green'},
  {name: 'Failed', color: 'red'},
]

function mergeSelectOptions(
  existing: NotionSelectOption[] | undefined,
  desired: Array<{name: string; color: string}>,
): NotionSelectOption[] {
  const merged: NotionSelectOption[] = []
  const seen = new Set<string>()

  for (const option of existing ?? []) {
    const name = option.name?.trim()
    if (!name) continue
    const normalized = name.toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    merged.push(option)
  }

  for (const option of desired) {
    const normalized = option.name.trim().toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    merged.push(option)
  }

  return merged
}

function reconcileSelectOptions(
  existing: NotionSelectOption[] | undefined,
  desired: Array<{name: string; color: string}>,
): NotionSelectOption[] {
  const existingByName = new Map<string, NotionSelectOption>()

  for (const option of existing ?? []) {
    const name = option.name?.trim()
    if (!name) continue
    const normalized = name.toLowerCase()
    if (existingByName.has(normalized)) continue
    existingByName.set(normalized, option)
  }

  const reconciled: NotionSelectOption[] = []
  const seen = new Set<string>()

  for (const option of desired) {
    const normalized = option.name.trim().toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    const current = existingByName.get(normalized)
    if (current) {
      reconciled.push({
        ...current,
        name: option.name,
        color: current.color ?? option.color,
      })
      continue
    }

    reconciled.push(option)
  }

  return reconciled
}

export async function notionEnsureBoardSchema(
  token: string,
  dataSourceId: string,
  _legacyStepOptions: Array<{name: string; color: string}> = [],
  pipeOptions: Array<{name: string; color: string}> = [],
): Promise<void> {
  const currentDataSource = await notionGetDataSource(token, dataSourceId)
  const patchRes = await fetch(
    `https://api.notion.com/v1/data_sources/${dataSourceId}`,
    {
      method: 'PATCH',
      headers: notionHeaders(token),
      body: JSON.stringify({
        properties: {
          Status: {
            select: {
              options: reconcileSelectOptions(
                currentDataSource.properties.Status?.select?.options,
                STATE_OPTIONS,
              ),
            },
          },
          Pipe: {
            select: {
              options: mergeSelectOptions(
                currentDataSource.properties.Pipe?.select?.options,
                pipeOptions,
              ),
            },
          },
          'Current Action': {rich_text: {}},
          Progress: {rich_text: {}},
          PR: {url: {}},
        },
      }),
    },
  )

  if (!patchRes.ok) {
    const text = await patchRes.text()
    throw new Error(
      `Notion board schema update failed (${patchRes.status}): ${text}`,
    )
  }
}

export async function notionGetDataSource(
  token: string,
  dataSourceId: string,
): Promise<NotionDataSource> {
  const res = await fetch(
    `https://api.notion.com/v1/data_sources/${dataSourceId}`,
    {
      headers: notionHeaders(token),
    },
  )

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Notion data source read failed (${res.status}): ${text}`)
  }

  return (await res.json()) as NotionDataSource
}

export function notionAssertSharedBoardSchema(
  dataSource: NotionDataSource,
): void {
  const expectedTypes: Array<[property: string, type: string]> = [
    ['Status', 'select'],
    ['Pipe', 'select'],
    ['Current Action', 'rich_text'],
    ['Progress', 'rich_text'],
    ['PR', 'url'],
  ]

  const issues = expectedTypes.flatMap(([propertyName, expectedType]) => {
    const property = dataSource.properties[propertyName]
    if (!property) {
      return [`missing ${propertyName}`]
    }
    if (property.type !== expectedType) {
      return [
        `${propertyName} must be ${expectedType} (found ${property.type})`,
      ]
    }
    return []
  })

  if (issues.length === 0) return

  throw new Error(
    `Shared Notion board schema is invalid for data source ${dataSource.id}: ${issues.join('; ')}`,
  )
}

function normalizeNotionId(id: string): string | null {
  const hex = id.replace(/[^0-9a-f]/gi, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) return null
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function notionExtractDatabaseIdFromUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  const match = parsed.pathname.match(/[0-9a-fA-F]{32}/)
  if (!match?.[0]) return null
  return normalizeNotionId(match[0])
}

export async function notionGetDatabase(
  token: string,
  databaseId: string,
): Promise<NotionDatabase> {
  const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
    headers: notionHeaders(token),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Notion database read failed (${res.status}): ${text}`)
  }

  return (await res.json()) as NotionDatabase
}

export async function notionResolveDatabaseConnection(
  token: string,
  databaseId: string,
): Promise<NotionDatabaseConnection> {
  const database = await notionGetDatabase(token, databaseId)
  const dataSourceId = database.data_sources?.[0]?.id
  if (!dataSourceId) {
    throw new Error(
      `Notion database ${database.id} is missing a data source id`,
    )
  }

  return {
    databaseId: database.id,
    dataSourceId,
    url: database.url ?? null,
  }
}

export async function notionResolveDatabaseConnectionFromUrl(
  token: string,
  url: string,
): Promise<NotionDatabaseConnection> {
  const databaseId = notionExtractDatabaseIdFromUrl(url)
  if (!databaseId) {
    throw new Error(`Could not extract Notion database id from URL: ${url}`)
  }

  return notionResolveDatabaseConnection(token, databaseId)
}

export async function notionCreateTaskPage(
  token: string,
  dataSourceId: string,
  input: {title: string; state: string; pipeId?: string},
): Promise<NotionCreatePageResult> {
  const properties: Record<string, unknown> = {
    Name: {title: [{text: {content: input.title}}]},
    Status: {select: {name: input.state}},
  }
  if (input.pipeId !== undefined) {
    properties.Pipe = {select: {name: input.pipeId}}
  }

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: notionHeaders(token),
    body: JSON.stringify({
      parent: {data_source_id: dataSourceId},
      properties,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Notion task create failed (${res.status}): ${text}`)
  }

  return (await res.json()) as NotionCreatePageResult
}

export async function notionWaitForTaskPipe(
  token: string,
  pageId: string,
  expectedPipeId: string,
  input: {maxAttempts?: number; delayMs?: number} = {},
): Promise<void> {
  const maxAttempts = input.maxAttempts ?? 12
  const delayMs = input.delayMs ?? 500

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const page = await notionGetPage(token, pageId)
    if (pagePipeId(page) === expectedPipeId) {
      return
    }

    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }

  throw new Error(
    [
      `Timed out waiting for shared-board page ${pageId} to report Pipe=${expectedPipeId}.`,
      'Notion may not have applied the select property yet.',
    ].join(' '),
  )
}

export async function notionGetPage(
  token: string,
  pageId: string,
): Promise<NotionPage> {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: notionHeaders(token),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Notion page read failed (${res.status}): ${text}`)
  }

  return (await res.json()) as NotionPage
}

export function mapTaskStateToNotionStatus(state: string): string {
  const normalized = state.trim().toLowerCase().replace(/[\s-]+/g, '_')

  switch (normalized) {
    case 'queue':
    case 'queued':
      return 'Queue'
    case 'in_progress':
      return 'In Progress'
    case 'needs_input':
      return 'Needs Input'
    case 'done':
      return 'Done'
    case 'failed':
      return 'Failed'
    default:
      return state
  }
}

function notionRichTextValue(
  text: string | null,
): Array<{type: 'text'; text: {content: string}}> {
  if (!text || text.trim().length === 0) return []
  return [{type: 'text', text: {content: clipNotionText(text)}}]
}

export async function notionUpdateTaskPage(
  token: string,
  pageId: string,
  patch: {
    state?: string
    currentAction?: string | null
    progress?: string | null
    prUrl?: string | null
  },
): Promise<void> {
  const properties: Record<string, unknown> = {}

  if (patch.state !== undefined) {
    properties.Status = {
      select: {name: mapTaskStateToNotionStatus(patch.state)},
    }
  }
  if (patch.currentAction !== undefined) {
    properties['Current Action'] = {
      rich_text: notionRichTextValue(patch.currentAction),
    }
  }
  if (patch.progress !== undefined) {
    properties.Progress = {
      rich_text: notionRichTextValue(patch.progress),
    }
  }
  if (patch.prUrl !== undefined) {
    properties.PR = {url: patch.prUrl}
  }

  if (Object.keys(properties).length === 0) return

  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: notionHeaders(token),
    body: JSON.stringify({properties}),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Notion task update failed (${res.status}): ${text}`)
  }
}

export async function notionUpdateTaskPageState(
  token: string,
  pageId: string,
  state: string,
  stepLabel?: string,
): Promise<void> {
  await notionUpdateTaskPage(token, pageId, {
    state,
    currentAction: stepLabel,
  })
}

function clipNotionText(text: string, max = 1800): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 3)}...`
}

export function richTextToPlainText(
  richText: Array<{plain_text?: string}> | undefined,
): string {
  if (!Array.isArray(richText)) return ''
  return richText
    .map(part => part.plain_text ?? '')
    .join('')
    .trim()
}

function blockPlainText(block: NotionBlock): string {
  const payload = block[block.type] as
    | {rich_text?: Array<{plain_text?: string}>}
    | undefined
  if (!payload) return ''
  return richTextToPlainText(payload.rich_text)
}

export async function notionGetPageMarkdown(
  token: string,
  pageId: string,
): Promise<string> {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}/markdown`, {
    headers: notionHeaders(token),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Notion page markdown read failed (${res.status}): ${text}`)
  }

  const body = (await res.json()) as NotionPageMarkdown
  return body.markdown ?? ''
}

// Block types a human would add as feedback (excludes our callout/toggle/code log blocks)
const HUMAN_BLOCK_TYPES = new Set([
  'paragraph',
  'bulleted_list_item',
  'numbered_list_item',
  'quote',
  'heading_1',
  'heading_2',
  'heading_3',
])

export async function notionGetNewPageBodyText(
  token: string,
  pageId: string,
  since: string,
): Promise<string> {
  if (!since) return ''

  const res = await fetch(
    `https://api.notion.com/v1/blocks/${pageId}/children?page_size=50`,
    {
      headers: notionHeaders(token),
    },
  )

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Notion page blocks read failed (${res.status}): ${text}`)
  }

  const body = (await res.json()) as {
    results?: Array<NotionBlock & {created_time: string}>
  }
  const lines = (body.results ?? [])
    .filter(
      block => HUMAN_BLOCK_TYPES.has(block.type) && block.created_time > since,
    )
    .map(block => blockPlainText(block))
    .filter(line => line.length > 0)
  return lines.join('\n\n').trim()
}

export async function notionFindPageByTitle(
  token: string,
  title: string,
): Promise<string | null> {
  const res = await fetch('https://api.notion.com/v1/search', {
    method: 'POST',
    headers: notionHeaders(token),
    body: JSON.stringify({
      query: title,
      filter: {property: 'object', value: 'page'},
      page_size: 20,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Notion search failed (${res.status}): ${text}`)
  }

  const body = (await res.json()) as {
    results?: Array<{id: string; title?: Array<{plain_text?: string}>}>
  }
  const exact = body.results?.find(
    r =>
      r.title?.[0]?.plain_text?.trim().toLowerCase() ===
      title.trim().toLowerCase(),
  )
  if (exact) return exact.id
  return body.results?.[0]?.id ?? null
}

export function pageTitle(page: NotionPage): string {
  for (const value of Object.values(page.properties)) {
    if (
      value?.type === 'title' &&
      Array.isArray(value.title) &&
      value.title[0]?.plain_text
    ) {
      return value.title[0].plain_text as string
    }
  }
  return page.id
}

export function pageState(page: NotionPage): string | null {
  const statusProp = page.properties.Status
  if (statusProp?.type === 'select') {
    return statusProp.select?.name?.toLowerCase() ?? null
  }

  const legacyProp = page.properties.State
  if (legacyProp?.type === 'select') {
    return legacyProp.select?.name?.toLowerCase() ?? null
  }

  return null
}

export function pagePipeId(page: NotionPage): string | null {
  const prop = page.properties.Pipe
  if (prop?.type === 'select') return prop.select?.name ?? null
  return null
}

export async function notionListComments(
  token: string,
  pageId: string,
): Promise<NotionComment[]> {
  const comments: NotionComment[] = []
  let startCursor: string | null = null

  while (true) {
    const params = new URLSearchParams({
      block_id: pageId,
      page_size: '100',
    })
    if (startCursor) {
      params.set('start_cursor', startCursor)
    }

    const res = await fetch(`https://api.notion.com/v1/comments?${params}`, {
      headers: notionHeaders(token),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Notion list comments failed (${res.status}): ${text}`)
    }

    const body = (await res.json()) as {
      results?: NotionComment[]
      has_more?: boolean
      next_cursor?: string | null
    }

    comments.push(...(body.results ?? []))
    if (!body.has_more) return comments
    startCursor = body.next_cursor ?? null
    if (!startCursor) return comments
  }
}

export async function notionReplacePageMarkdown(
  token: string,
  pageId: string,
  markdown: string,
): Promise<void> {
  const res = await fetch(
    `https://api.notion.com/v1/pages/${pageId}/markdown`,
    {
      method: 'PATCH',
      headers: notionHeaders(token),
      body: JSON.stringify({
        type: 'replace_content',
        replace_content: {new_str: markdown},
      }),
    },
  )

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Notion markdown replace failed (${res.status}): ${text}`)
  }
}

export async function notionPostComment(
  token: string,
  pageId: string,
  text: string,
): Promise<void> {
  const res = await fetch('https://api.notion.com/v1/comments', {
    method: 'POST',
    headers: notionHeaders(token),
    body: JSON.stringify({
      parent: {page_id: pageId},
      rich_text: [{type: 'text', text: {content: clipNotionText(text, 2000)}}],
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Notion post comment failed (${res.status}): ${err}`)
  }
}

export async function notionGetNewComments(
  token: string,
  pageId: string,
  since: string,
): Promise<string> {
  const comments = await notionListComments(token, pageId)
  const newComments = comments
    .filter(c => c.created_time > since)
    .map(c => richTextToPlainText(c.rich_text))
    .filter(t => t.length > 0)
  return newComments.join('\n\n').trim()
}
