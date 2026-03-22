import {afterEach, describe, expect, it} from 'vitest'
import {
  notionArchiveDatabase,
  notionAssertSharedBoardSchema,
  notionCreateBoardDataSource,
  notionCreateTaskPage,
  notionResolveDatabaseConnection,
  notionEnsureBoardSchema,
  notionExtractDatabaseIdFromUrl,
  notionGetPageMarkdown,
  notionListComments,
  notionQueryAllDataSourcePages,
  notionQueryDataSource,
  notionReplacePageMarkdown,
  notionResolveDatabaseConnectionFromUrl,
  notionUpdateTaskPage,
  notionWaitForTaskPipe,
  pagePipeId,
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
    statusOptions: Array<{name: string; color?: string; id?: string}>
    pipeOptions: Array<{name: string; color?: string; id?: string}>
    currentActionType: string
    progressType: string
    prType: string
  }> = {},
) {
  return {
    id: 'ds-1',
    properties: {
      Name: {type: 'title'},
      Status: {
        type: 'select',
        select: {options: overrides.statusOptions ?? []},
      },
      Pipe: {
        type: 'select',
        select: {options: overrides.pipeOptions ?? []},
      },
      'Current Action': {
        type: overrides.currentActionType ?? 'rich_text',
      },
      Progress: {
        type: overrides.progressType ?? 'rich_text',
      },
      PR: {
        type: overrides.prType ?? 'url',
      },
    },
  }
}

const STATE_OPTIONS = [
  {name: 'Queue', color: 'gray'},
  {name: 'In Progress', color: 'blue'},
  {name: 'Needs Input', color: 'orange'},
  {name: 'Done', color: 'green'},
  {name: 'Failed', color: 'red'},
]

describe('notion task page helpers', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('updates task properties for the task board adapter contract', async () => {
    const calls: Array<{input: RequestInfo | URL; init?: RequestInit}> = []
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({input, init})
      return jsonResponse({})
    }) as typeof fetch

    await notionUpdateTaskPage('token-1', 'page-1', {
      state: 'in_progress',
      currentAction: 'Implement adapter',
      progress: '50% Implementing',
      prUrl: 'https://github.com/example/repo/pull/123',
    })

    expect(calls).toHaveLength(1)
    expect(String(calls[0]?.input)).toContain('/v1/pages/page-1')
    expect(calls[0]?.init?.method).toBe('PATCH')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      properties: {
        Status: {select: {name: 'In Progress'}},
        'Current Action': {
          rich_text: [{type: 'text', text: {content: 'Implement adapter'}}],
        },
        Progress: {
          rich_text: [{type: 'text', text: {content: '50% Implementing'}}],
        },
        PR: {url: 'https://github.com/example/repo/pull/123'},
      },
    })
  })

  it('reads page markdown from the markdown api', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        object: 'page_markdown',
        id: 'page-1',
        markdown: '# Fresh Start\n\nThis is the artifact.',
      })) as typeof fetch

    await expect(notionGetPageMarkdown('token-1', 'page-1')).resolves.toBe(
      '# Fresh Start\n\nThis is the artifact.',
    )
  })

  it('replaces page markdown using replace_content', async () => {
    const calls: Array<{input: RequestInfo | URL; init?: RequestInit}> = []
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({input, init})
      return jsonResponse({})
    }) as typeof fetch

    await notionReplacePageMarkdown(
      'token-1',
      'page-1',
      '# Fresh Start\n\nThis replaces all previous content.',
    )

    expect(calls).toHaveLength(1)
    expect(String(calls[0]?.input)).toContain('/v1/pages/page-1/markdown')
    expect(calls[0]?.init?.method).toBe('PATCH')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      type: 'replace_content',
      replace_content: {
        new_str: '# Fresh Start\n\nThis replaces all previous content.',
      },
    })
  })

  it('lists comments across pagination and preserves author metadata', async () => {
    let callCount = 0
    globalThis.fetch = (async () => {
      callCount += 1
      if (callCount === 1) {
        return jsonResponse({
          results: [
            {
              id: 'comment-1',
              created_time: '2026-03-22T10:00:00.000Z',
              created_by: {id: 'user-1'},
              display_name: {type: 'user', resolved_name: 'Reviewer'},
              rich_text: [{plain_text: 'Looks good'}],
            },
          ],
          has_more: true,
          next_cursor: 'cursor-2',
        })
      }

      return jsonResponse({
        results: [
          {
            id: 'comment-2',
            created_time: '2026-03-22T10:05:00.000Z',
            created_by: {id: 'bot-1', type: 'bot'},
            display_name: {type: 'integration', resolved_name: 'Notionflow'},
            rich_text: [{plain_text: 'Queued for work'}],
          },
        ],
        has_more: false,
        next_cursor: null,
      })
    }) as typeof fetch

    await expect(notionListComments('token-1', 'page-1')).resolves.toEqual([
      {
        id: 'comment-1',
        created_time: '2026-03-22T10:00:00.000Z',
        created_by: {id: 'user-1'},
        display_name: {type: 'user', resolved_name: 'Reviewer'},
        rich_text: [{plain_text: 'Looks good'}],
      },
      {
        id: 'comment-2',
        created_time: '2026-03-22T10:05:00.000Z',
        created_by: {id: 'bot-1', type: 'bot'},
        display_name: {type: 'integration', resolved_name: 'Notionflow'},
        rich_text: [{plain_text: 'Queued for work'}],
      },
    ])
  })
})

describe('notion board schema provisioning', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('updates board schema with lifecycle status and task metadata properties', async () => {
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
        'Current Action': {rich_text: {}},
        Pipe: {select: {options: []}},
        PR: {url: {}},
        Progress: {rich_text: {}},
        Status: {select: {options: STATE_OPTIONS}},
      },
    })
    expect(payload.properties.Ready).toBeUndefined()
  })

  it('keeps lifecycle Status options even when legacy step options are provided', async () => {
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
          pipeOptions: [{name: 'demo', color: 'default', id: 'opt-demo'}],
        }),
      )
    }) as typeof fetch

    const stepOptions = [
      {name: '🛠️ setup', color: 'purple'},
      {name: '📋 plan', color: 'pink'},
    ]
    const pipeOptions = [
      {name: 'demo', color: 'blue'},
      {name: 'research', color: 'green'},
    ]
    await notionEnsureBoardSchema('token-1', 'ds-1', stepOptions, pipeOptions)

    const payload = JSON.parse(String(calls[1]?.init?.body))
    expect(payload.properties.Status.select.options).toEqual(STATE_OPTIONS)
    expect(payload.properties.Pipe.select.options).toEqual([
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
    expect(patchPayload.properties.Status.select.options).toEqual(STATE_OPTIONS)
    expect(patchPayload.properties.Pipe.select.options).toEqual([])
    expect(patchPayload.properties['Current Action']).toEqual({rich_text: {}})
    expect(patchPayload.properties.Progress).toEqual({rich_text: {}})
    expect(patchPayload.properties.PR).toEqual({url: {}})
    expect(patchPayload.properties.Ready).toBeUndefined()
  })

  it('provisions a workspace-level board when step and pipe options are empty', async () => {
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

    const result = await notionCreateBoardDataSource(
      'token-1',
      'Workspace Board',
    )

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

    await notionCreateBoardDataSource('token-1', 'Nested Board', [], [], {
      parentPageId: 'page-123',
    })

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
          pipeOptions: [{name: 'verify-happy', color: 'pink', id: 'pipe-1'}],
          statusOptions: [{name: 'Done', color: 'orange', id: 'status-1'}],
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
      {name: 'Queue', color: 'gray'},
      {name: 'In Progress', color: 'blue'},
      {name: 'Needs Input', color: 'orange'},
      {name: 'Done', color: 'orange', id: 'status-1'},
      {name: 'Failed', color: 'red'},
    ])
    expect(payload.properties.Pipe.select.options).toEqual([
      {name: 'verify-happy', color: 'pink', id: 'pipe-1'},
      {name: 'verify-feedback', color: 'green'},
    ])
  })

  it('writes Status and Pipe when creating a task page', async () => {
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
      pipeId: 'demo',
    })

    const payload = JSON.parse(String(calls[0]?.init?.body))
    expect(payload.properties.Status).toEqual({select: {name: 'Queue'}})
    expect(payload.properties.Pipe).toEqual({select: {name: 'demo'}})
    expect(payload.properties.State).toBeUndefined()
  })

  it('waits for a created task page to report the expected Pipe', async () => {
    let reads = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/v1/pages/page-1')) {
        reads += 1
        return jsonResponse({
          id: 'page-1',
          properties: {
            Pipe:
              reads >= 3
                ? {type: 'select', select: {name: 'demo'}}
                : {type: 'select', select: null},
          },
        })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    }) as typeof fetch

    await expect(
      notionWaitForTaskPipe('token-1', 'page-1', 'demo', {
        maxAttempts: 3,
        delayMs: 0,
      }),
    ).resolves.toBeUndefined()
    expect(reads).toBe(3)
  })

  it('fails when a created task page never reports the expected Pipe', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/v1/pages/page-1')) {
        return jsonResponse({
          id: 'page-1',
          properties: {
            Pipe: {type: 'select', select: null},
          },
        })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    }) as typeof fetch

    await expect(
      notionWaitForTaskPipe('token-1', 'page-1', 'demo', {
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

  it('queries a data source page with cursor and pipe filter', async () => {
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
        pipeId: 'alpha',
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
        property: 'Pipe',
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
          Status: {type: 'select'},
          Pipe: {type: 'select'},
          'Current Action': {type: 'rich_text'},
          Progress: {type: 'rich_text'},
          PR: {type: 'url'},
        },
      }),
    ).not.toThrow()
  })

  it('fails loudly when a required shared board property is missing', () => {
    expect(() =>
      notionAssertSharedBoardSchema({
        id: 'ds-1',
        properties: {
          Status: {type: 'select'},
          Pipe: {type: 'select'},
          'Current Action': {type: 'rich_text'},
          Progress: {type: 'rich_text'},
        },
      }),
    ).toThrow(
      'Shared Notion board schema is invalid for data source ds-1: missing PR',
    )
  })

  it('fails loudly when a shared board property has the wrong type', () => {
    expect(() =>
      notionAssertSharedBoardSchema({
        id: 'ds-1',
        properties: {
          Status: {type: 'select'},
          Pipe: {type: 'select'},
          'Current Action': {type: 'rich_text'},
          Progress: {type: 'select'},
          PR: {type: 'url'},
        },
      }),
    ).toThrow(
      'Shared Notion board schema is invalid for data source ds-1: Progress must be rich_text (found select)',
    )
  })

  it('reads the Pipe property from a task page', () => {
    expect(
      pagePipeId({
        id: 'page-1',
        properties: {
          Pipe: {
            type: 'select',
            select: {name: 'research'},
          },
        },
      }),
    ).toBe('research')
  })
})
