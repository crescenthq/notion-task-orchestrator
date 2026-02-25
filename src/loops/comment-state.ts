import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type CommentRouteState = {
  lastSeenCommentTime: string;
  seenCommentIds: string[];
  seenEventFingerprints: string[];
  needsInputConsecutive: number;
  escalationCount: number;
  lastEscalatedAt?: string;
};

export type CommentState = {
  version: 2;
  routes: Record<string, CommentRouteState>;
};

const DEFAULT_ROUTE_STATE: CommentRouteState = {
  lastSeenCommentTime: "",
  seenCommentIds: [],
  seenEventFingerprints: [],
  needsInputConsecutive: 0,
  escalationCount: 0
};

const DEFAULT_STATE: CommentState = { version: 2, routes: {} };

function normalizeRouteState(input: any): CommentRouteState {
  return {
    lastSeenCommentTime:
      typeof input?.lastSeenCommentTime === "string"
        ? input.lastSeenCommentTime
        : typeof input?.lastSeen === "string"
          ? input.lastSeen
          : "",
    seenCommentIds: Array.isArray(input?.seenCommentIds)
      ? input.seenCommentIds.filter((x: unknown) => typeof x === "string")
      : [],
    seenEventFingerprints: Array.isArray(input?.seenEventFingerprints)
      ? input.seenEventFingerprints.filter((x: unknown) => typeof x === "string")
      : [],
    needsInputConsecutive:
      typeof input?.needsInputConsecutive === "number" && Number.isFinite(input.needsInputConsecutive)
        ? Math.max(0, Math.floor(input.needsInputConsecutive))
        : 0,
    escalationCount:
      typeof input?.escalationCount === "number" && Number.isFinite(input.escalationCount)
        ? Math.max(0, Math.floor(input.escalationCount))
        : 0,
    lastEscalatedAt: typeof input?.lastEscalatedAt === "string" ? input.lastEscalatedAt : undefined
  };
}

export function routeKey(boardId: string, runId: string, pageId: string) {
  return `${boardId}::${runId}::${pageId}`;
}

export function legacyRouteKey(pageId: string) {
  return `legacy::${pageId}`;
}

export function getOrInitRouteState(state: CommentState, key: string): CommentRouteState {
  if (!state.routes[key]) {
    state.routes[key] = {
      ...DEFAULT_ROUTE_STATE,
      seenCommentIds: [],
      seenEventFingerprints: []
    };
  }
  return state.routes[key];
}

export async function loadCommentState(path: string): Promise<CommentState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_STATE, routes: {} };

    if (parsed.version === 2 && typeof parsed.routes === "object" && parsed.routes) {
      const routes = Object.fromEntries(
        Object.entries(parsed.routes).map(([key, value]) => [key, normalizeRouteState(value)])
      );
      return {
        version: 2,
        routes
      };
    }

    if (typeof parsed.perPage === "object" && parsed.perPage) {
      const routes: Record<string, CommentRouteState> = {};
      for (const [pageId, lastSeen] of Object.entries(parsed.perPage)) {
        routes[legacyRouteKey(pageId)] = {
          ...DEFAULT_ROUTE_STATE,
          seenCommentIds: [],
          seenEventFingerprints: [],
          lastSeenCommentTime: typeof lastSeen === "string" ? lastSeen : ""
        };
      }
      return {
        version: 2,
        routes
      };
    }

    return { ...DEFAULT_STATE, routes: {} };
  } catch {
    return { ...DEFAULT_STATE, routes: {} };
  }
}

export async function saveCommentState(path: string, state: CommentState) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf8");
}
