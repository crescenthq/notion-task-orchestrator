import { mkdir } from "node:fs/promises";
import { paths } from "../config/paths";
import { ensureDbDirectory, bootstrapSchema } from "../db/bootstrap";
import { openDatabase } from "../db/client";

export function nowIso(): string {
  return new Date().toISOString();
}

export async function openApp() {
  await ensureDbDirectory(paths.db);
  await mkdir(paths.agentsDir, { recursive: true });
  await mkdir(paths.workflowsDir, { recursive: true });
  const { db, sqlite } = openDatabase(paths.db);
  bootstrapSchema(sqlite);
  return { db, sqlite };
}
