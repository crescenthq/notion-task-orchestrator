import { afterEach, describe, expect, it } from "vitest";
import { notionCreateBoardDataSource, notionEnsureBoardSchema } from "./notion";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const STATE_OPTIONS = [
  { name: "Queue", color: "gray" },
  { name: "In Progress", color: "blue" },
  { name: "Waiting", color: "yellow" },
  { name: "Done", color: "green" },
  { name: "Blocked", color: "orange" },
  { name: "Failed", color: "red" },
];

describe("notion board schema provisioning", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("updates board schema with State (operational) and Status (steps) properties", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return jsonResponse({});
    }) as typeof fetch;

    await notionEnsureBoardSchema("token-1", "ds-1");

    expect(calls).toHaveLength(1);
    const payload = JSON.parse(String(calls[0]?.init?.body));
    expect(payload).toEqual({
      properties: {
        State: { select: { options: STATE_OPTIONS } },
        Status: { select: { options: [] } },
      },
    });
    expect(payload.properties.Ready).toBeUndefined();
  });

  it("includes step options in Status when provided", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return jsonResponse({});
    }) as typeof fetch;

    const stepOptions = [
      { name: "🛠️ setup", color: "purple" },
      { name: "📋 plan", color: "pink" },
    ];
    await notionEnsureBoardSchema("token-1", "ds-1", stepOptions);

    const payload = JSON.parse(String(calls[0]?.init?.body));
    expect(payload.properties.State.select.options).toEqual(STATE_OPTIONS);
    expect(payload.properties.Status.select.options).toEqual(stepOptions);
  });

  it("provisions a board and applies schema without Ready property", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      const url = String(input);

      if (url.endsWith("/v1/databases")) {
        return jsonResponse({
          id: "db-1",
          url: "https://notion.so/db-1",
          data_sources: [{ id: "ds-1", name: "Board" }],
        });
      }

      return jsonResponse({});
    }) as typeof fetch;

    const result = await notionCreateBoardDataSource("token-1", "parent-1", "My Board");

    expect(result).toEqual({
      dataSourceId: "ds-1",
      databaseId: "db-1",
      url: "https://notion.so/db-1",
    });
    expect(calls).toHaveLength(2);

    const createPayload = JSON.parse(String(calls[0]?.init?.body));
    expect(createPayload.properties).toEqual({ Name: { title: {} } });

    const patchPayload = JSON.parse(String(calls[1]?.init?.body));
    expect(patchPayload.properties.State.select.options).toEqual(STATE_OPTIONS);
    expect(patchPayload.properties.Status.select.options).toEqual([]);
    expect(patchPayload.properties.Ready).toBeUndefined();
  });
});
