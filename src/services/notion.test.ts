import {afterEach, describe, expect, it} from 'vitest'
import {
  notionArchiveDatabase,
  notionAssertSharedBoardSchema,
  notionCreateBoardDataSource,
  notionCreateTaskPage,
  notionResolveDatabaseConnection,
  notionEnsureBoardSchema,
  notionExtractDatabaseIdFromUrl,
  notionQueryAllDataSourcePages,
  notionQueryDataSource,
  notionResolveDatabaseConnectionFromUrl,
  notionWaitForTaskFactory,
  pageFactoryId,
} from './notion'

const originalFetch = globalThis.fetch

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json'},
  })
}

function buildSharedBoardDataSource(
  overrides: Partial<{
    stateOptions: Array<{name: string; color?: string; id?: string}>
    statusOptions: Array<{name: string; color?: string; id?: string}>
    factoryOptions: Array<{name: string; color?: string; id?: string}>
  }> = {},
) {
  return {
    id: 'ds-1',
    properties: {
      Name: {type: 'title'},
      State: {
        type: 'select',
        select: {options: overrides.stateOptions ?? []},
      },
      Status: {
        type: 'select',
        select: {options: overrides.statusOptions ?? []},
      },
      Factory: {
        type: 'select',
        select: {options: overrides.factoryOptions ?? []},
      },
    },
  }
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
      if (init?.method === 'PATCH') {
        return jsonResponse({})
      }
      return jsonResponse(buildSharedBoardDataSource())
    }) as typeof fetch

    await notionEnsureBoardSchema('token-1', 'ds-1')

    expect(calls).toHaveLength(2)
    const payload = JSON.parse(String(calls[1]?.init?.body))
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
      if (init?.method === 'PATCH') {
        return jsonResponse({})
      }
      return jsonResponse(
        buildSharedBoardDataSource({
          factoryOptions: [{name: 'demo', color: 'default', id: 'opt-demo'}],
        }),
      )
    }) as typeof fetch

    const stepOptions = [
      {name: '🛠️ setup', color: 'purple'},
      {name: '📋 plan', color: 'pink'},
    ]
    const factoryOptions = [
      {name: 'demo', color: 'blue'},
      {name: 'research', color: 'green'},
    ]
    await notionEnsureBoardSchema(
      'token-1',
      'ds-1',
      stepOptions,
      factoryOptions,
    )

    const payload = JSON.parse(String(calls[1]?.init?.body))
    expect(payload.properties.State.select.options).toEqual(STATE_OPTIONS)
    expect(payload.properties.Status.select.options).toEqual(stepOptions)
    expect(payload.properties.Factory.select.options).toEqual([
      {name: 'demo', color: 'default', id: 'opt-demo'},
      {name: 'research', color: 'green'},
    ])
  })

  it('provisions a workspace-level board and applies schema without Ready property', async () => {
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

      if (init?.method !== 'PATCH') {
        return jsonResponse(buildSharedBoardDataSource())
      }

      return jsonResponse({})
    }) as typeof fetch

    const result = await notionCreateBoardDataSource('token-1', 'My Board')

    expect(result).toEqual({
      dataSourceId: 'ds-1',
      databaseId: 'db-1',
      url: 'https://notion.so/db-1',
    })
    expect(calls).toHaveLength(3)

    const createPayload = JSON.parse(String(calls[0]?.init?.body))
    expect(createPayload.parent).toEqual({
      type: 'workspace',
      workspace: true,
    })
    expect(createPayload.initial_data_source.properties).toEqual({
      Name: {title: {}},
    })

    const patchPayload = JSON.parse(String(calls[2]?.init?.body))
    expect(patchPayload.properties.State.select.options).toEqual(STATE_OPTIONS)
    expect(patchPayload.properties.Status.select.options).toEqual([])
    expect(patchPayload.properties.Factory.select.options).toEqual([])
    expect(patchPayload.properties.Ready).toBeUndefined()
  })

  it('provisions a workspace-level board when step and factory options are empty', async () => {
    const calls: Array<{input: RequestInfo | URL; init?: RequestInit}> = []
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({input, init})
      const url = String(input)

      if (url.endsWith('/v1/databases')) {
        return jsonResponse({
          id: 'db-workspace',
          url: 'https://notion.so/db-workspace',
          data_sources: [{id: 'ds-workspace', name: 'Board'}],
        })
      }

      if (init?.method !== 'PATCH') {
        return jsonResponse({
          ...buildSharedBoardDataSource(),
          id: 'ds-workspace',
        })
      }

      return jsonResponse({})
    }) as typeof fetch

    const result = await notionCreateBoardDataSource('token-1', 'Workspace Board')

    expect(result).toEqual({
      dataSourceId: 'ds-workspace',
      databaseId: 'db-workspace',
      url: 'https://notion.so/db-workspace',
    })

    const createPayload = JSON.parse(String(calls[0]?.init?.body))
    expect(createPayload.parent).toEqual({
      type: 'workspace',
      workspace: true,
    })
    expect(createPayload.initial_data_source.properties).toEqual({
      Name: {title: {}},
    })
  })

  it('provisions a board under an explicit parent page when requested', async () => {
    const calls: Array<{input: RequestInfo | URL; init?: RequestInit}> = []
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({input, init})
      const url = String(input)

      if (url.endsWith('/v1/databases')) {
        return jsonResponse({
          id: 'db-page',
          url: 'https://notion.so/db-page',
          data_sources: [{id: 'ds-page', name: 'Board'}],
        })
      }

      if (init?.method !== 'PATCH') {
        return jsonResponse({
          ...buildSharedBoardDataSource(),
          id: 'ds-page',
        })
      }

      return jsonResponse({})
    }) as typeof fetch

    await notionCreateBoardDataSource(
      'token-1',
      'Nested Board',
      [],
      [],
      {parentPageId: 'page-123'},
    )

    const createPayload = JSON.parse(String(calls[0]?.init?.body))
    expect(createPayload.parent).toEqual({
      type: 'page_id',
      page_id: 'page-123',
    })
  })

  it('preserves existing select colors when reconciling schema', async () => {
    const calls: Array<{input: RequestInfo | URL; init?: RequestInit}> = []
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({input, init})
      if (init?.method === 'PATCH') {
        return jsonResponse({})
      }
      return jsonResponse(
        buildSharedBoardDataSource({
          factoryOptions: [
            {name: 'verify-happy', color: 'pink', id: 'factory-1'},
          ],
          statusOptions: [{name: 'complete', color: 'orange', id: 'status-1'}],
        }),
      )
    }) as typeof fetch

    await notionEnsureBoardSchema(
      'token-1',
      'ds-1',
      [{name: 'complete', color: 'green'}],
      [
        {name: 'verify-happy', color: 'blue'},
        {name: 'verify-feedback', color: 'green'},
      ],
    )

    const payload = JSON.parse(String(calls[1]?.init?.body))
    expect(payload.properties.Status.select.options).toEqual([
      {name: 'complete', color: 'orange', id: 'status-1'},
    ])
    expect(payload.properties.Factory.select.options).toEqual([
      {name: 'verify-happy', color: 'pink', id: 'factory-1'},
      {name: 'verify-feedback', color: 'green'},
    ])
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

  it('waits for a created task page to report the expected Factory', async () => {
    let reads = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/v1/pages/page-1')) {
        reads += 1
        return jsonResponse({
          id: 'page-1',
          properties: {
            Factory:
              reads >= 3
                ? {type: 'select', select: {name: 'demo'}}
                : {type: 'select', select: null},
          },
        })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    }) as typeof fetch

    await expect(
      notionWaitForTaskFactory('token-1', 'page-1', 'demo', {
        maxAttempts: 3,
        delayMs: 0,
      }),
    ).resolves.toBeUndefined()
    expect(reads).toBe(3)
  })

  it('fails when a created task page never reports the expected Factory', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/v1/pages/page-1')) {
        return jsonResponse({
          id: 'page-1',
          properties: {
            Factory: {type: 'select', select: null},
          },
        })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    }) as typeof fetch

    await expect(
      notionWaitForTaskFactory('token-1', 'page-1', 'demo', {
        maxAttempts: 2,
        delayMs: 0,
      }),
    ).rejects.toThrow(/Timed out waiting for shared-board page page-1/)
  })

  it('archives a database by moving it to trash', async () => {
    const calls: Array<{input: RequestInfo | URL; init?: RequestInit}> = []
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({input, init})
      return jsonResponse({})
    }) as typeof fetch

    await notionArchiveDatabase('token-1', 'db-1')

    expect(calls).toHaveLength(1)
    expect(String(calls[0]?.input)).toContain('/v1/databases/db-1')
    expect(calls[0]?.init?.method).toBe('PATCH')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({in_trash: true})
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

  it('resolves a database connection from a database id', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        id: '12345678-90ab-cdef-1234-567890abcdef',
        url: 'https://notion.so/shared-board',
        data_sources: [{id: 'ds-1', name: 'Shared Board'}],
      })) as typeof fetch

    await expect(
      notionResolveDatabaseConnection(
        'token-1',
        '12345678-90ab-cdef-1234-567890abcdef',
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
          results: [
            {id: 'page-1', properties: {}},
            {id: 'page-2', properties: {}},
          ],
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
    ).toThrow(
      'Shared Notion board schema is invalid for data source ds-1: missing Factory',
    )
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
