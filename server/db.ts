import { and, asc, desc, eq, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  approvals,
  auditRecords,
  eventAttempts,
  events,
  sideEffectExecutions,
  type EventSource,
  type EventStatus,
  type InsertRelayEvent,
  InsertUser,
  users,
} from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("Database is unavailable");
  return db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function findEventByIdempotency(source: EventSource, idempotencyKey: string) {
  const db = await requireDb();
  return (
    await db
      .select()
      .from(events)
      .where(and(eq(events.source, source), eq(events.idempotencyKey, idempotencyKey)))
      .limit(1)
  )[0];
}

export async function createEvent(values: InsertRelayEvent) {
  const db = await requireDb();
  await db.insert(events).values(values);
  return (await db.select().from(events).where(eq(events.id, values.id)).limit(1))[0];
}

export async function getEvent(eventId: string) {
  const db = await requireDb();
  return (await db.select().from(events).where(eq(events.id, eventId)).limit(1))[0];
}

export async function listEvents(status?: EventStatus) {
  const db = await requireDb();
  if (status) return db.select().from(events).where(eq(events.status, status)).orderBy(desc(events.receivedAt));
  return db.select().from(events).orderBy(desc(events.receivedAt));
}

export async function updateEvent(
  eventId: string,
  values: Partial<Pick<InsertRelayEvent, "status" | "retryCount" | "nextRetryAt" | "isDeadLetter">>
) {
  const db = await requireDb();
  await db.update(events).set(values).where(eq(events.id, eventId));
  return getEvent(eventId);
}

export async function addAttempt(values: typeof eventAttempts.$inferInsert) {
  const db = await requireDb();
  await db.insert(eventAttempts).values(values);
}

export async function addAudit(values: typeof auditRecords.$inferInsert) {
  const db = await requireDb();
  await db.insert(auditRecords).values(values);
}

export async function getEventDetail(eventId: string) {
  const db = await requireDb();
  const event = await getEvent(eventId);
  if (!event) return undefined;
  const [attempts, approvalRows, audit] = await Promise.all([
    db.select().from(eventAttempts).where(eq(eventAttempts.eventId, eventId)).orderBy(asc(eventAttempts.createdAt)),
    db.select().from(approvals).where(eq(approvals.eventId, eventId)).orderBy(desc(approvals.createdAt)),
    db.select().from(auditRecords).where(eq(auditRecords.eventId, eventId)).orderBy(asc(auditRecords.createdAt)),
  ]);
  return { event, attempts, approvals: approvalRows, audit };
}

export async function getLatestApproval(eventId: string) {
  const db = await requireDb();
  return (
    await db.select().from(approvals).where(eq(approvals.eventId, eventId)).orderBy(desc(approvals.createdAt)).limit(1)
  )[0];
}

export async function createApproval(values: typeof approvals.$inferInsert) {
  const db = await requireDb();
  await db.insert(approvals).values(values);
}

export async function decideApproval(eventId: string, decision: "approved" | "rejected", comment: string, operatorName: string) {
  const db = await requireDb();
  const approval = await getLatestApproval(eventId);
  if (!approval || approval.decision !== "pending") throw new Error("No pending approval exists for this event");
  await db.update(approvals).set({ decision, comment, operatorName, decidedAt: new Date() }).where(eq(approvals.id, approval.id));
}

export async function listDueRetryEvents(now: Date) {
  const db = await requireDb();
  return db
    .select()
    .from(events)
    .where(and(eq(events.status, "failed"), eq(events.isDeadLetter, false), lte(events.nextRetryAt, now)));
}

export async function claimSideEffect(eventId: string, operationKey: string, executionId: string) {
  const db = await requireDb();
  try {
    await db.insert(sideEffectExecutions).values({ id: executionId, eventId, operationKey });
    return true;
  } catch (error) {
    const databaseError = typeof error === "object" && error && "cause" in error ? (error as { cause?: unknown }).cause : error;
    const code = typeof databaseError === "object" && databaseError && "code" in databaseError ? String((databaseError as { code?: unknown }).code) : "";
    const message = error instanceof Error ? error.message : "";
    if (code === "ER_DUP_ENTRY" || message.includes("Duplicate entry")) return false;
    throw error;
  }
}
