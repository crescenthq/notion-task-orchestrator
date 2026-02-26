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
  stepStatusOptions: Array<{ name: string; color: string }> = [],
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

  await notionEnsureBoardSchema(token, dataSourceId, stepStatusOptions);
  return { dataSourceId, databaseId: database.id, url: database.url ?? null };
}

const STATE_OPTIONS = [
  { name: "Queue", color: "gray" },
  { name: "In Progress", color: "blue" },
  { name: "Waiting", color: "yellow" },
  { name: "Done", color: "green" },
  { name: "Blocked", color: "orange" },
  { name: "Failed", color: "red" },
];

export async function notionEnsureBoardSchema(
  token: string,
  dataSourceId: string,
  stepOptions: Array<{ name: string; color: string }> = [],
): Promise<void> {
  const patchRes = await fetch(`https://api.notion.com/v1/data_sources/${dataSourceId}`, {
    method: "PATCH",
    headers: notionHeaders(token),
    body: JSON.stringify({
      properties: {
        State: { select: { options: STATE_OPTIONS } },
        Status: { select: { options: stepOptions } },
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
  input: { title: string; state: string },
): Promise<NotionCreatePageResult> {
  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: notionHeaders(token),
    body: JSON.stringify({
      parent: { data_source_id: dataSourceId },
      properties: {
        Name: { title: [{ text: { content: input.title } }] },
        State: { select: { name: input.state } },
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
      return "Queue";
    case "running":
      return "In Progress";
    case "waiting":
      return "Waiting";
    case "done":
      return "Done";
    case "blocked":
      return "Blocked";
    case "failed":
      return "Failed";
    default:
      return state;
  }
}

function inferCalloutEmoji(title: string): string {
  const t = title.toLowerCase();
  if (t.startsWith("task complete") || t.startsWith("done")) return "✅";
  if (t.includes("failed") || t.includes("fail")) return "❌";
  if (t.includes("blocked")) return "🛑";
  if (t.includes("feedback needed") || t.includes("waiting for")) return "🤔";
  if (t.includes("started") || t.includes("start")) return "🚀";
  return "ℹ️";
}

export async function notionUpdateTaskPageState(
  token: string,
  pageId: string,
  state: string,
  stepLabel?: string,
): Promise<void> {
  const notionState = mapTaskStateToNotionStatus(state);
  const properties: Record<string, unknown> = {
    State: { select: { name: notionState } },
  };
  if (stepLabel !== undefined) {
    properties.Status = { select: { name: stepLabel } };
  }

  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: notionHeaders(token),
    body: JSON.stringify({ properties }),
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
  const emoji = inferCalloutEmoji(title);
  const calloutText = detail && detail.trim().length > 0
    ? clipNotionText(`${title} — ${detail.trim()}`, 2000)
    : clipNotionText(title, 2000);

  const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
    method: "PATCH",
    headers: notionHeaders(token),
    body: JSON.stringify({
      children: [
        {
          object: "block",
          type: "callout",
          callout: {
            rich_text: [{ type: "text", text: { content: calloutText } }],
            icon: { emoji },
          },
        },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion task log append failed (${res.status}): ${text}`);
  }
}

export async function notionAppendStepToggle(
  token: string,
  pageId: string,
  stepLabel: string,
  executorId: string,
  status: string,
  output: string,
): Promise<void> {
  const statusEmoji = status === "done" ? "✅" : status === "failed" ? "❌" : "🛑";
  const toggleTitle = clipNotionText(`${statusEmoji} ${stepLabel} via ${executorId}`, 200);
  const clippedOutput = clipNotionText(output.trim() || "(no output)");

  const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
    method: "PATCH",
    headers: notionHeaders(token),
    body: JSON.stringify({
      children: [
        {
          object: "block",
          type: "toggle",
          toggle: {
            rich_text: [{ type: "text", text: { content: toggleTitle } }],
            children: [
              {
                object: "block",
                type: "code",
                code: {
                  language: "plain text",
                  rich_text: [{ type: "text", text: { content: clippedOutput } }],
                },
              },
            ],
          },
        },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion step toggle append failed (${res.status}): ${text}`);
  }
}

export function richTextToPlainText(richText: Array<{ plain_text?: string }> | undefined): string {
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

// Block types a human would add as feedback (excludes our callout/toggle/code log blocks)
const HUMAN_BLOCK_TYPES = new Set([
  "paragraph",
  "bulleted_list_item",
  "numbered_list_item",
  "quote",
  "heading_1",
  "heading_2",
  "heading_3",
]);

export async function notionGetNewPageBodyText(token: string, pageId: string, since: string): Promise<string> {
  if (!since) return "";

  const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=50`, {
    headers: notionHeaders(token),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion page blocks read failed (${res.status}): ${text}`);
  }

  const body = (await res.json()) as { results?: Array<NotionBlock & { created_time: string }> };
  const lines = (body.results ?? [])
    .filter((block) => HUMAN_BLOCK_TYPES.has(block.type) && block.created_time > since)
    .map((block) => blockPlainText(block))
    .filter((line) => line.length > 0);
  return lines.join("\n\n").trim();
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

export function pageState(page: NotionPage): string | null {
  const prop = page.properties.State;
  if (prop?.type === "select") return prop.select?.name?.toLowerCase() ?? null;
  return null;
}

type NotionComment = {
  id: string;
  created_time: string;
  rich_text: Array<{ plain_text?: string }>;
};

export async function notionListComments(token: string, pageId: string): Promise<NotionComment[]> {
  const res = await fetch(`https://api.notion.com/v1/comments?block_id=${pageId}`, {
    headers: notionHeaders(token),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion list comments failed (${res.status}): ${text}`);
  }

  const body = (await res.json()) as { results?: NotionComment[] };
  return body.results ?? [];
}
