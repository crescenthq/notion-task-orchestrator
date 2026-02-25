import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths } from "./paths.js";

export type BoardConfig = {
  id: string;
  name?: string;
  notionDataSourceId: string;
  notionApiKeyEnv?: string;
  defaultWorkflowId?: string;
  pickerIntervalMs?: number;
  commentIntervalMs?: number;
};

export type BoardRegistry = {
  version: 1;
  boards: BoardConfig[];
};

const DEFAULT_REGISTRY: BoardRegistry = {
  version: 1,
  boards: []
};

export function boardRegistryPath() {
  return process.env.BOARD_REGISTRY_FILE ?? paths.boards;
}

async function ensureParent(filePath: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
}

export async function loadBoardRegistry(filePath = boardRegistryPath()): Promise<BoardRegistry> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as BoardRegistry;
    if (!Array.isArray(parsed?.boards)) {
      throw new Error("Invalid board registry: boards must be an array");
    }
    return {
      version: 1,
      boards: parsed.boards
    };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { ...DEFAULT_REGISTRY };
    }
    throw err;
  }
}

export async function saveBoardRegistry(registry: BoardRegistry, filePath = boardRegistryPath()) {
  await ensureParent(filePath);
  await writeFile(filePath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

export function validateBoard(board: BoardConfig) {
  if (!board.id?.trim()) throw new Error("Board id is required");
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(board.id)) {
    throw new Error(`Invalid board id: ${board.id}. Use alphanumerics, dash, underscore.`);
  }
  if (!board.notionDataSourceId?.trim()) {
    throw new Error(`Board ${board.id}: notionDataSourceId is required`);
  }
}

export async function addBoard(board: BoardConfig, filePath = boardRegistryPath()) {
  validateBoard(board);
  const registry = await loadBoardRegistry(filePath);
  if (registry.boards.some((b) => b.id === board.id)) {
    throw new Error(`Board already exists: ${board.id}`);
  }

  registry.boards.push({
    ...board,
    notionApiKeyEnv: board.notionApiKeyEnv || "NOTION_API_KEY"
  });

  await saveBoardRegistry(registry, filePath);
  return board;
}

export async function removeBoard(boardId: string, filePath = boardRegistryPath()) {
  const registry = await loadBoardRegistry(filePath);
  const before = registry.boards.length;
  registry.boards = registry.boards.filter((b) => b.id !== boardId);
  const removed = before !== registry.boards.length;
  if (removed) await saveBoardRegistry(registry, filePath);
  return removed;
}

export async function getBoard(boardId: string, filePath = boardRegistryPath()) {
  const registry = await loadBoardRegistry(filePath);
  return registry.boards.find((b) => b.id === boardId) ?? null;
}
