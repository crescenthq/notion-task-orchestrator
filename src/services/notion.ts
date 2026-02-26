type NotionUser = {
  object: string;
  id: string;
  name: string | null;
  type: string;
};

type NotionPage = {
  id: string;
  properties: Record<string, any>;
};

type NotionDatabase = {
  id: string;
  data_sources?: Array<{ id: string; name: string }>;
  url?: string;
};

type NotionDataSource = {
  id: string;
  database_parent?: { page_id?: string };
  properties: Record<string, { type: string }>;
  url?: string;
};

type NotionCreatePageResult = {
  id: string;
  url?: string;
};

type NotionBlock = {
  type: string;
  [key: string]: any;
};

const NOTION_VERSION = "2025-09-03";

function notionHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

export async function notionWhoAmI(token: string): Promise<NotionUser> {
  const res = await fetch("https://api.notion.com/v1/users/me", {
    headers: notionHeaders(token),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion auth failed (${res.status}): ${text}`);
  }

  return (await res.json()) as NotionUser;
}

export async function notionQueryDataSource(token: string, dataSourceId: string, pageSize = 20): Promise<NotionPage[]> {
  const res = await fetch(`https://api.notion.com/v1/data_sources/${dataSourceId}/query`, {
    method: "POST",
    headers: notionHeaders(token),
    body: JSON.stringify({ page_size: pageSize }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion query failed (${res.status}): ${text}`);
  }

  const body = (await res.json()) as { results: NotionPage[] };
  return body.results;
}

export async function notionCreateBoardDataSource(
  token: string,
  parentPageId: string,
  title: string,
): Promise<{ dataSourceId: string; databaseId: string; url: string | null }> {
  const createRes = await fetch("https://api.notion.com/v1/databases", {
    method: "POST",
    headers: notionHeaders(token),
    body: JSON.stringify({
      parent: { type: "page_id", page_id: parentPageId },
      title: [{ type: "text", text: { content: title } }],
      properties: {
        Name: { title: {} },
      },
    }),
  });

  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(`Notion board create failed (${createRes.status}): ${text}`);
  }

  const database = (await createRes.json()) as NotionDatabase;
  const dataSourceId = database.data_sources?.[0]?.id;
  if (!dataSourceId) throw new Error("Notion board create succeeded but no data source id was returned");

  await notionEnsureBoardSchema(token, dataSourceId);
  return { dataSourceId, databaseId: database.id, url: database.url ?? null };
}

export async function notionEnsureBoardSchema(token: string, dataSourceId: string): Promise<void> {
  const patchRes = await fetch(`https://api.notion.com/v1/data_sources/${dataSourceId}`, {
    method: "PATCH",
    headers: notionHeaders(token),
    body: JSON.stringify({
      properties: {
        Status: { select: {} },
        Ready: { checkbox: {} },
        Workflow: { rich_text: {} },
      },
    }),
  });

  if (!patchRes.ok) {
    const text = await patchRes.text();
    throw new Error(`Notion board schema update failed (${patchRes.status}): ${text}`);
  }
}

export async function notionGetDataSource(token: string, dataSourceId: string): Promise<NotionDataSource> {
  const res = await fetch(`https://api.notion.com/v1/data_sources/${dataSourceId}`, {
    headers: notionHeaders(token),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion data source read failed (${res.status}): ${text}`);
  }

  return (await res.json()) as NotionDataSource;
}

export async function notionCreateTaskPage(
  token: string,
  dataSourceId: string,
  input: { title: string; status: string; ready: boolean; workflowId?: string },
): Promise<NotionCreatePageResult> {
  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: notionHeaders(token),
    body: JSON.stringify({
      parent: { data_source_id: dataSourceId },
      properties: {
        Name: { title: [{ text: { content: input.title } }] },
        Status: { select: { name: input.status } },
        Ready: { checkbox: input.ready },
        Workflow: {
          rich_text: input.workflowId ? [{ text: { content: input.workflowId } }] : [],
        },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion task create failed (${res.status}): ${text}`);
  }

  return (await res.json()) as NotionCreatePageResult;
}

export async function notionGetPage(token: string, pageId: string): Promise<NotionPage> {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: notionHeaders(token),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion page read failed (${res.status}): ${text}`);
  }

  return (await res.json()) as NotionPage;
}

export function mapTaskStateToNotionStatus(state: string): string {
  switch (state) {
    case "queued":
      return "queue";
    case "running":
      return "in_progress";
    case "done":
      return "done";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    default:
      return state;
  }
}

export async function notionUpdateTaskPageState(token: string, pageId: string, state: string): Promise<void> {
  const page = await notionGetPage(token, pageId);
  const statusType = page.properties.Status?.type;
  const notionStatus = mapTaskStateToNotionStatus(state);
  const statusProperty = statusType === "status" ? { status: { name: notionStatus } } : { select: { name: notionStatus } };
  const ready = state === "queued";

  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: notionHeaders(token),
    body: JSON.stringify({
      properties: {
        Status: statusProperty,
        Ready: { checkbox: ready },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion task update failed (${res.status}): ${text}`);
  }
}

function clipNotionText(text: string, max = 1800): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

export async function notionAppendTaskPageLog(token: string, pageId: string, title: string, detail?: string): Promise<void> {
  const children: Array<Record<string, unknown>> = [
    {
      object: "block",
      type: "heading_3",
      heading_3: {
        rich_text: [{ type: "text", text: { content: clipNotionText(title, 200) } }],
      },
    },
  ];

  if (detail && detail.trim().length > 0) {
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: clipNotionText(detail.trim()) } }],
      },
    });
  }

  const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
    method: "PATCH",
    headers: notionHeaders(token),
    body: JSON.stringify({ children }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion task log append failed (${res.status}): ${text}`);
  }
}

function richTextToPlainText(richText: Array<{ plain_text?: string }> | undefined): string {
  if (!Array.isArray(richText)) return "";
  return richText.map((part) => part.plain_text ?? "").join("").trim();
}

function blockPlainText(block: NotionBlock): string {
  const payload = block[block.type] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
  if (!payload) return "";
  return richTextToPlainText(payload.rich_text);
}

export async function notionGetPageBodyText(token: string, pageId: string, pageSize = 50): Promise<string> {
  const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=${pageSize}`, {
    headers: notionHeaders(token),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion page blocks read failed (${res.status}): ${text}`);
  }

  const body = (await res.json()) as { results?: NotionBlock[] };
  const lines = (body.results ?? [])
    .map((block) => blockPlainText(block))
    .filter((line) => line.length > 0);
  return lines.join("\n").trim();
}

export async function notionFindPageByTitle(token: string, title: string): Promise<string | null> {
  const res = await fetch("https://api.notion.com/v1/search", {
    method: "POST",
    headers: notionHeaders(token),
    body: JSON.stringify({
      query: title,
      filter: { property: "object", value: "page" },
      page_size: 20,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion search failed (${res.status}): ${text}`);
  }

  const body = (await res.json()) as { results?: Array<{ id: string; title?: Array<{ plain_text?: string }> }> };
  const exact = body.results?.find((r) => r.title?.[0]?.plain_text?.trim().toLowerCase() === title.trim().toLowerCase());
  if (exact) return exact.id;
  return body.results?.[0]?.id ?? null;
}

export function pageTitle(page: NotionPage): string {
  for (const value of Object.values(page.properties)) {
    if (value?.type === "title" && Array.isArray(value.title) && value.title[0]?.plain_text) {
      return value.title[0].plain_text as string;
    }
  }
  return page.id;
}

export function pageStatus(page: NotionPage): string | null {
  const statusProp = page.properties.Status;
  if (statusProp?.type === "status") return statusProp.status?.name?.toLowerCase() ?? null;
  if (statusProp?.type === "select") return statusProp.select?.name?.toLowerCase() ?? null;
  return null;
}

export function pageReady(page: NotionPage): boolean {
  const ready = page.properties.Ready ?? page.properties["Ready to build"];
  if (ready?.type === "checkbox") return Boolean(ready.checkbox);
  return false;
}

export function pageWorkflowId(page: NotionPage): string | null {
  const workflow = page.properties.Workflow;
  if (workflow?.type !== "rich_text" || !Array.isArray(workflow.rich_text)) return null;
  const value = workflow.rich_text.map((part: { plain_text?: string }) => part.plain_text ?? "").join("").trim();
  return value.length > 0 ? value : null;
}
