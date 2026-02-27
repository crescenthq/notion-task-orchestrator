import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const boards = sqliteTable("boards", {
  id: text("id").primaryKey(),
  adapter: text("adapter").notNull(),
  externalId: text("external_id").notNull(),
  configJson: text("config_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});


export const workflows = sqliteTable("workflows", {
  id: text("id").primaryKey(),
  version: integer("version").notNull().default(1),
  definitionYaml: text("definition_yaml").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  boardId: text("board_id").notNull(),
  externalTaskId: text("external_task_id").notNull(),
  workflowId: text("workflow_id").notNull(),
  state: text("state").notNull(),
  currentStepId: text("current_step_id"),
  stepVarsJson: text("step_vars_json"),
  waitingSince: text("waiting_since"),
  lockToken: text("lock_token"),
  lockExpiresAt: text("lock_expires_at"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  status: text("status").notNull(),
  currentStateId: text("current_state_id"),
  contextJson: text("context_json"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: text("lease_expires_at"),
  leaseHeartbeatAt: text("lease_heartbeat_at"),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});


export const inboxEvents = sqliteTable("inbox_events", {
  id: text("id").primaryKey(),
  boardId: text("board_id").notNull(),
  taskId: text("task_id"),
  source: text("source").notNull(),
  fingerprint: text("fingerprint").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const boardCursors = sqliteTable("board_cursors", {
  boardId: text("board_id").primaryKey(),
  commentsCursor: text("comments_cursor"),
  tasksCursor: text("tasks_cursor"),
  updatedAt: text("updated_at").notNull(),
});

export const transitionEvents = sqliteTable("transition_events", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  tickId: text("tick_id").notNull(),
  taskId: text("task_id").notNull(),
  fromStateId: text("from_state_id").notNull(),
  toStateId: text("to_state_id").notNull(),
  event: text("event").notNull(),
  reason: text("reason").notNull(),
  attempt: integer("attempt").notNull().default(0),
  loopIteration: integer("loop_iteration").notNull().default(0),
  timestamp: text("timestamp").notNull(),
});
