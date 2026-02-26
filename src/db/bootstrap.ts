import { mkdir } from "node:fs/promises";
import path from "node:path";

export async function ensureDbDirectory(dbPath: string): Promise<void> {
  await mkdir(path.dirname(dbPath), { recursive: true });
}

export function bootstrapSchema(sqlite: { exec: (sql: string) => void }): void {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  adapter TEXT NOT NULL,
  external_id TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS executors (
  id TEXT PRIMARY KEY,
  command_path TEXT NOT NULL,
  default_timeout_seconds INTEGER,
  default_retries INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  definition_yaml TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  external_task_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  state TEXT NOT NULL,
  current_step_id TEXT,
  lock_token TEXT,
  lock_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(board_id, external_task_id),
  FOREIGN KEY(board_id) REFERENCES boards(id),
  FOREIGN KEY(workflow_id) REFERENCES workflows(id)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS step_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  executor_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  output_text TEXT NOT NULL,
  output_kv_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id),
  FOREIGN KEY(executor_id) REFERENCES executors(id)
);

CREATE TABLE IF NOT EXISTS inbox_events (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  task_id TEXT,
  source TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source, fingerprint),
  FOREIGN KEY(board_id) REFERENCES boards(id),
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS board_cursors (
  board_id TEXT PRIMARY KEY,
  comments_cursor TEXT,
  tasks_cursor TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(board_id) REFERENCES boards(id)
);
`);
}
