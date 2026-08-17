import {
  boolean,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const eventSources = [
  "form_submission",
  "payment",
  "telegram_message",
  "downstream_api_failure",
] as const;

export const eventStatuses = [
  "received",
  "processing",
  "completed",
  "failed",
  "pending_approval",
] as const;

export const events = mysqlTable(
  "events",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    source: mysqlEnum("source", eventSources).notNull(),
    idempotencyKey: varchar("idempotencyKey", { length: 255 }).notNull(),
    correlationId: varchar("correlationId", { length: 64 }).notNull(),
    operationKey: varchar("operationKey", { length: 320 }).notNull(),
    status: mysqlEnum("status", eventStatuses).default("received").notNull(),
    payload: json("payload").$type<Record<string, unknown>>().notNull(),
    maskedPayload: json("maskedPayload").$type<Record<string, unknown>>().notNull(),
    retryCount: int("retryCount").default(0).notNull(),
    maxRetries: int("maxRetries").default(3).notNull(),
    nextRetryAt: timestamp("nextRetryAt"),
    isDeadLetter: boolean("isDeadLetter").default(false).notNull(),
    replayOfEventId: varchar("replayOfEventId", { length: 36 }),
    receivedAt: timestamp("receivedAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("events_source_idempotency_uq").on(table.source, table.idempotencyKey),
    index("events_status_received_idx").on(table.status, table.receivedAt),
    index("events_correlation_idx").on(table.correlationId),
  ]
);

export const sideEffectExecutions = mysqlTable(
  "side_effect_executions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    eventId: varchar("eventId", { length: 36 })
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    operationKey: varchar("operationKey", { length: 320 }).notNull(),
    completedAt: timestamp("completedAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("side_effect_executions_operation_uq").on(table.operationKey),
    index("side_effect_executions_event_idx").on(table.eventId),
  ]
);

export const eventAttempts = mysqlTable(
  "event_attempts",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    eventId: varchar("eventId", { length: 36 })
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    attemptNumber: int("attemptNumber").notNull(),
    result: mysqlEnum("result", ["success", "error", "paused"]).notNull(),
    detail: text("detail"),
    scheduledFor: timestamp("scheduledFor"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [index("event_attempts_event_idx").on(table.eventId, table.createdAt)]
);

export const approvals = mysqlTable(
  "approvals",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    eventId: varchar("eventId", { length: 36 })
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    decision: mysqlEnum("decision", ["pending", "approved", "rejected"]).default("pending").notNull(),
    operatorName: varchar("operatorName", { length: 128 }),
    comment: text("comment"),
    decidedAt: timestamp("decidedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [index("approvals_event_idx").on(table.eventId, table.createdAt)]
);

export const auditRecords = mysqlTable(
  "audit_records",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    eventId: varchar("eventId", { length: 36 })
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    action: varchar("action", { length: 96 }).notNull(),
    message: text("message").notNull(),
    metadata: json("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [index("audit_records_event_idx").on(table.eventId, table.createdAt)]
);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type RelayEvent = typeof events.$inferSelect;
export type InsertRelayEvent = typeof events.$inferInsert;
export type EventSource = (typeof eventSources)[number];
export type EventStatus = (typeof eventStatuses)[number];
