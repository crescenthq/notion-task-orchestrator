export type NotionPage = {
  id: string;
  properties: Record<string, any>;
};

export type QueueTask = {
  pageId: string;
  name: string;
  status: string | null;
};

export function rt(content: string) {
  return {
    rich_text: [{ type: "text", text: { content } }]
  };
}

export function titleFromPage(page: NotionPage, prop = "name") {
  const arr = page.properties?.[prop]?.title ?? [];
  return arr.map((x: any) => x?.plain_text ?? "").join("").trim();
}

export function statusFromPage(page: NotionPage, prop = "status") {
  return page.properties?.[prop]?.status?.name ?? page.properties?.[prop]?.select?.name ?? null;
}

export function richTextFromPage(page: NotionPage, prop: string) {
  const arr = page.properties?.[prop]?.rich_text ?? [];
  return arr.map((x: any) => x?.plain_text ?? "").join("").trim();
}
