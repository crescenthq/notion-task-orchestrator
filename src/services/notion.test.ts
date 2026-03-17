import {afterEach, describe, expect, it} from 'vitest'
import {
  notionAssertSharedBoardSchema,
  notionCreateBoardDataSource,
  notionCreateTaskPage,
  notionEnsureBoardSchema,
  notionExtractDatabaseIdFromUrl,
  notionQueryAllDataSourcePages,
  notionQueryDataSource,
  notionResolveDatabaseConnectionFromUrl,
  pageFactoryId,
} from './notion'

const originalFetch = globalThis.fetch

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json'},
  })
}

const STATE_OPTIONS = [
  {name: 'Queue', color: 'gray'},
  {name: 'In Progress', color: 'blue'},
  {name: 'Feedback', color: 'purple'},
  {name: 'Done', color: 'green'},
  {name: 'Blocked', color: 'orange'},
  {name: 'Failed', color: 'red'},
]

describe('notion board schema provisioning', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('updates board schema with State (operational) and Status (steps) properties', async () => {
    const calls: Array<{input: RequestInfo | URL; init?: RequestInit}> = []
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({input, init})
      return jsonResponse({})
    }) as typeof fetch

    await notionEnsureBoardSchema('token-1', 'ds-1')

    expect(calls).toHaveLength(1)
    const payload = JSON.parse(String(calls[0]?.init?.body))
    expect(payload).toEqual({
      properties: {
        Factory: {select: {options: []}},
        State: {select: {options: STATE_OPTIONS}},
        Status: {select: {options: []}},
      },
    })
    expect(payload.properties.Ready).toBeUndefined()
  })

  it('includes step options in Status when provided', async () => {
    const calls: Array<{input: RequestInfo | URL; init?: RequestInit}> = []
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({input, init})
      return jsonResponse({})
    }) as typeof fetch

    const stepOptions = [
      {name: '🛠️ setup', color: 'purple'},
      {name: '📋 plan', color: 'pink'},
    ]
    const factoryOptions = [
      {name: 'demo', color: 'blue'},
      {name: 'research', color: 'green'},
    ]
    await notionEnsureBoardSchema('token-1', 'ds-1', stepOptions, factoryOptions)

    const payload = JSON.parse(String(calls[0]?.init?.body))
    expect(payload.properties.State.select.options).toEqual(STATE_OPTIONS)
    expect(payload.properties.Status.select.options).toEqual(stepOptions)
    expect(payload.properties.Factory.select.options).toEqual(factoryOptions)
  })

  it('provisions a board and applies schema without Ready property', async () => {
    const calls: Array<{input: RequestInfo | URL; init?: RequestInit}> = []
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({input, init})
      const url = String(input)

      if (url.endsWith('/v1/databases')) {
        return jsonResponse({
          id: 'db-1',
          url: 'https://notion.so/db-1',
          data_sources: [{id: 'ds-1', name: 'Board'}],
        })
      }

      return jsonResponse({})
    }) as typeof fetch

    const result = await notionCreateBoardDataSource(
      'token-1',
      'parent-1',
      'My Board',
    )

    expect(result).toEqual({
      dataSourceId: 'ds-1',
      databaseId: 'db-1',
      url: 'https://notion.so/db-1',
    })
    expect(calls).toHaveLength(2)

    const createPayload = JSON.parse(String(calls[0]?.init?.body))
    expect(createPayload.properties).toEqual({Name: {title: {}}})

    const patchPayload = JSON.parse(String(calls[1]?.init?.body))
    expect(patchPayload.properties.State.select.options).toEqual(STATE_OPTIONS)
    expect(patchPayload.properties.Status.select.options).toEqual([])
    expect(patchPayload.properties.Factory.select.options).toEqual([])
    expect(patchPayload.properties.Ready).toBeUndefined()
  })

  it('writes Factory when creating a task page', async () => {
    const calls: Array<{input: RequestInfo | URL; init?: RequestInit}> = []
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({input, init})
      return jsonResponse({id: 'page-1', url: 'https://notion.so/page-1'})
    }) as typeof fetch

    await notionCreateTaskPage('token-1', 'ds-1', {
      title: 'Shared task',
      state: 'Queue',
      factoryId: 'demo',
    })

    const payload = JSON.parse(String(calls[0]?.init?.body))
    expect(payload.properties.Factory).toEqual({select: {name: 'demo'}})
  })

  it('extracts a database id from a Notion URL', () => {
    expect(
      notionExtractDatabaseIdFromUrl(
        'https://www.notion.so/workspace/Shared-Board-1234567890abcdef1234567890abcdef?v=feedfacefeedfacefeedfacefeedface',
      ),
    ).toBe('12345678-90ab-cdef-1234-567890abcdef')
  })

  it('resolves a database connection from a Notion URL', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        id: '12345678-90ab-cdef-1234-567890abcdef',
        url: 'https://notion.so/shared-board',
        data_sources: [{id: 'ds-1', name: 'Shared Board'}],
      })) as typeof fetch

    await expect(
      notionResolveDatabaseConnectionFromUrl(
        'token-1',
        'https://www.notion.so/workspace/Shared-Board-1234567890abcdef1234567890abcdef?v=feedfacefeedfacefeedfacefeedface',
      ),
    ).resolves.toEqual({
      databaseId: '12345678-90ab-cdef-1234-567890abcdef',
      dataSourceId: 'ds-1',
      url: 'https://notion.so/shared-board',
    })
  })

  it('queries a data source page with cursor and factory filter', async () => {
    const calls: Array<{input: RequestInfo | URL; init?: RequestInit}> = []
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({input, init})
      return jsonResponse({
        results: [{id: 'page-1', properties: {}}],
        has_more: true,
        next_cursor: 'cursor-2',
      })
    }) as typeof fetch

    await expect(
      notionQueryDataSource('token-1', 'ds-1', {
        pageSize: 50,
        startCursor: 'cursor-1',
        factoryId: 'alpha',
      }),
    ).resolves.toEqual({
      results: [{id: 'page-1', properties: {}}],
      hasMore: true,
      nextCursor: 'cursor-2',
    })

    const payload = JSON.parse(String(calls[0]?.init?.body))
    expect(payload).toEqual({
      page_size: 50,
      start_cursor: 'cursor-1',
      filter: {
        property: 'Factory',
        select: {equals: 'alpha'},
      },
    })
  })

  it('queries all data source pages across cursors', async () => {
    let callCount = 0
    globalThis.fetch = (async () => {
      callCount += 1
      if (callCount === 1) {
        return jsonResponse({
          results: [{id: 'page-1', properties: {}}, {id: 'page-2', properties: {}}],
          has_more: true,
          next_cursor: 'cursor-2',
        })
      }

      return jsonResponse({
        results: [{id: 'page-3', properties: {}}],
        has_more: false,
        next_cursor: null,
      })
    }) as typeof fetch

    await expect(
      notionQueryAllDataSourcePages('token-1', 'ds-1', {pageSize: 50}),
    ).resolves.toEqual([
      {id: 'page-1', properties: {}},
      {id: 'page-2', properties: {}},
      {id: 'page-3', properties: {}},
    ])
  })

  it('fails when a later data source page query fails', async () => {
    let callCount = 0
    globalThis.fetch = (async () => {
      callCount += 1
      if (callCount === 1) {
        return jsonResponse({
          results: [{id: 'page-1', properties: {}}],
          has_more: true,
          next_cursor: 'cursor-2',
        })
      }

      return new Response('boom', {status: 500})
    }) as typeof fetch

    await expect(
      notionQueryAllDataSourcePages('token-1', 'ds-1', {pageSize: 50}),
    ).rejects.toThrow('Notion query failed (500): boom')
  })

  it('accepts a shared board schema with compatible property types', () => {
    expect(() =>
      notionAssertSharedBoardSchema({
        id: 'ds-1',
        properties: {
          State: {type: 'select'},
          Status: {type: 'select'},
          Factory: {type: 'select'},
        },
      }),
    ).not.toThrow()
  })

  it('fails loudly when a required shared board property is missing', () => {
    expect(() =>
      notionAssertSharedBoardSchema({
        id: 'ds-1',
        properties: {
          State: {type: 'select'},
          Status: {type: 'select'},
        },
      }),
    ).toThrow('Shared Notion board schema is invalid for data source ds-1: missing Factory')
  })

  it('fails loudly when a shared board property has the wrong type', () => {
    expect(() =>
      notionAssertSharedBoardSchema({
        id: 'ds-1',
        properties: {
          State: {type: 'select'},
          Status: {type: 'select'},
          Factory: {type: 'rich_text'},
        },
      }),
    ).toThrow(
      'Shared Notion board schema is invalid for data source ds-1: Factory must be select (found rich_text)',
    )
  })

  it('reads the Factory property from a task page', () => {
    expect(
      pageFactoryId({
        id: 'page-1',
        properties: {
          Factory: {
            type: 'select',
            select: {name: 'research'},
          },
        },
      }),
    ).toBe('research')
  })
})
