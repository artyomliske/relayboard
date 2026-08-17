import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { z } from "zod";
import {
  eventSources,
  eventStatuses,
  type EventSource,
  type EventStatus,
  type RelayEvent,
} from "../drizzle/schema";
import {
  addAttempt,
  addAudit,
  claimSideEffect,
  createApproval,
  createEvent,
  decideApproval as persistApprovalDecision,
  findEventByIdempotency,
  getEvent,
  getEventDetail,
  getLatestApproval,
  listDueRetryEvents,
  listEvents,
  updateEvent,
} from "./db";
import { publishRelayboardUpdate } from "./eventStream";

export const relayboardSources = eventSources;
export const relayboardStatuses = eventStatuses;

const basePayload = z.object({
  source: z.enum(eventSources),
  idempotencyKey: z.string().trim().min(8).max(255),
  maxRetries: z.number().int().min(0).max(10).default(3),
  payload: z.record(z.string(), z.unknown()),
});

const sourcePayloadSchemas: Record<EventSource, z.ZodType<Record<string, unknown>>> = {
  form_submission: z.object({ fullName: z.string().min(1), email: z.string().email(), message: z.string().min(1) }),
  payment: z.object({ paymentId: z.string().min(1), amount: z.number().positive(), currency: z.string().length(3) }),
  telegram_message: z.object({ chatId: z.string().min(1), messageId: z.string().min(1), text: z.string().min(1) }),
  downstream_api_failure: z.object({ endpoint: z.string().min(1), statusCode: z.number().int().min(400), error: z.string().min(1) }),
};

export type RelayboardIngress = z.infer<typeof basePayload>;

export function parseIngress(value: unknown): RelayboardIngress {
  const parsed = basePayload.parse(value);
  sourcePayloadSchemas[parsed.source].parse(parsed.payload);
  return parsed;
}

function webhookSecret() {
  const secret = process.env.RELAYBOARD_WEBHOOK_SECRET;
  if (!secret) throw new Error("RELAYBOARD_WEBHOOK_SECRET is not configured");
  return secret;
}

export function signWebhookPayload(rawPayload: string, secret = webhookSecret()) {
  return createHmac("sha256", secret).update(rawPayload, "utf8").digest("hex");
}

export function verifyWebhookSignature(rawPayload: string, signature: string | undefined, secret = webhookSecret()) {
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(signWebhookPayload(rawPayload, secret), "hex");
  const received = Buffer.from(signature, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function maskPayload(value: unknown, key = "payload"): unknown {
  const sensitive = /(authorization|password|token|secret|email|phone|card|account)/i.test(key);
  if (sensitive && value !== null) return "[masked]";
  if (Array.isArray(value)) return value.map(item => maskPayload(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [childKey, maskPayload(childValue, childKey)]));
  }
  return value;
}

async function audit(eventId: string, action: string, message: string, metadata?: Record<string, unknown>) {
  await addAudit({ id: randomUUID(), eventId, action, message, metadata });
}

async function acceptEvent(input: RelayboardIngress) {
  const existing = await findEventByIdempotency(input.source, input.idempotencyKey);
  if (existing) return { event: existing, deduplicated: true };

  const id = randomUUID();
  const event = await createEvent({
    id,
    source: input.source,
    idempotencyKey: input.idempotencyKey,
    correlationId: randomUUID(),
    operationKey: `${input.source}:${input.idempotencyKey}`,
    status: "received",
    payload: input.payload,
    maskedPayload: maskPayload(input.payload) as Record<string, unknown>,
    retryCount: 0,
    maxRetries: input.maxRetries,
    isDeadLetter: false,
  });
  await audit(id, "event_received", "Event accepted into the inbox after signature and schema checks.");
  return { event, deduplicated: false };
}

export async function ingestWebhookRaw(rawPayload: string, signature: string | undefined) {
  if (!verifyWebhookSignature(rawPayload, signature)) throw new Error("Webhook signature is invalid");
  const parsed = parseIngress(JSON.parse(rawPayload));
  const accepted = await acceptEvent(parsed);
  if (!accepted.deduplicated) await processEvent(accepted.event.id);
  const detail = await getEventDetail(accepted.event.id);
  publishRelayboardUpdate();
  return { ...accepted, detail };
}

async function completeEvent(event: RelayEvent, detail: string) {
  const didExecuteSideEffect = await claimSideEffect(event.id, event.operationKey, randomUUID());
  const completionDetail = didExecuteSideEffect
    ? detail
    : "Replay completed without duplicating the existing side effect; the execution key was already consumed.";
  await addAttempt({ id: randomUUID(), eventId: event.id, attemptNumber: event.retryCount + 1, result: "success", detail: completionDetail });
  await updateEvent(event.id, { status: "completed", nextRetryAt: null, isDeadLetter: false });
  if (!didExecuteSideEffect) await audit(event.id, "side_effect_skipped", "Replay was protected by the existing side-effect execution key.", { operationKey: event.operationKey });
  await audit(event.id, "processing_completed", completionDetail, { operationKey: event.operationKey });
}

export async function processEvent(eventId: string) {
  const event = await getEvent(eventId);
  if (!event || event.isDeadLetter || event.status === "completed") return event;

  await updateEvent(event.id, { status: "processing", nextRetryAt: null });
  await audit(event.id, "processing_started", "Processing attempt started.", { attempt: event.retryCount + 1 });

  if (event.source === "telegram_message") {
    const approval = await getLatestApproval(event.id);
    if (!approval || approval.decision === "pending") {
      if (!approval) await createApproval({ id: randomUUID(), eventId: event.id, decision: "pending" });
      await addAttempt({
        id: randomUUID(),
        eventId: event.id,
        attemptNumber: event.retryCount + 1,
        result: "paused",
        detail: "Processing paused for operator review.",
      });
      await updateEvent(event.id, { status: "pending_approval" });
      await audit(event.id, "approval_requested", "Operator approval is required before this Telegram message can continue.");
      return getEvent(event.id);
    }
    if (approval.decision === "rejected") return getEvent(event.id);
    await completeEvent(event, "Approved Telegram message processing completed.");
    return getEvent(event.id);
  }

  if (event.source === "downstream_api_failure") {
    const retryCount = event.retryCount + 1;
    const exhausted = retryCount >= event.maxRetries;
    const retryDelayMinutes = 2 ** (retryCount - 1);
    const nextRetryAt = exhausted ? null : new Date(Date.now() + retryDelayMinutes * 60_000);
    await addAttempt({
      id: randomUUID(),
      eventId: event.id,
      attemptNumber: retryCount,
      result: "error",
      detail: "Synthetic downstream API failure recorded.",
      scheduledFor: nextRetryAt,
    });
    await updateEvent(event.id, { status: "failed", retryCount, nextRetryAt, isDeadLetter: exhausted });
    await audit(
      event.id,
      exhausted ? "dead_lettered" : "retry_scheduled",
      exhausted
        ? "Retries exhausted; event moved to the dead-letter queue."
        : `Retry ${retryCount} scheduled with exponential backoff.`,
      { retryCount, nextRetryAt: nextRetryAt?.toISOString() }
    );
    return getEvent(event.id);
  }

  await completeEvent(event, "Processing completed successfully.");
  return getEvent(event.id);
}

export async function processDueRetries() {
  const dueEvents = await listDueRetryEvents(new Date());
  for (const event of dueEvents) await processEvent(event.id);
  if (dueEvents.length) publishRelayboardUpdate();
  return { processed: dueEvents.length };
}

export async function decideApproval(eventId: string, decision: "approved" | "rejected", comment: string, operatorName = "Operator") {
  const event = await getEvent(eventId);
  if (!event || event.status !== "pending_approval") throw new Error("This event is not awaiting approval");
  await persistApprovalDecision(eventId, decision, comment, operatorName);
  await audit(eventId, `approval_${decision}`, `Operator ${decision} the event.`, { comment, operatorName });
  if (decision === "rejected") {
    await updateEvent(eventId, { status: "failed", nextRetryAt: null, isDeadLetter: false });
    const detail = await getEventDetail(eventId);
    publishRelayboardUpdate();
    return detail;
  }
  await updateEvent(eventId, { status: "processing" });
  await processEvent(eventId);
  const detail = await getEventDetail(eventId);
  publishRelayboardUpdate();
  return detail;
}

export async function replayEvent(eventId: string) {
  const original = await getEvent(eventId);
  if (!original) throw new Error("Event not found");
  const replayId = randomUUID();
  const replay = await createEvent({
    id: replayId,
    source: original.source,
    idempotencyKey: `replay_${replayId}`,
    correlationId: randomUUID(),
    operationKey: original.operationKey,
    status: "received",
    payload: original.payload,
    maskedPayload: original.maskedPayload,
    retryCount: 0,
    maxRetries: original.maxRetries,
    isDeadLetter: false,
    replayOfEventId: original.id,
  });
  await audit(replayId, "event_replayed", "Event replay created with a new correlation ID.", { replayOfEventId: original.id });
  await processEvent(replay.id);
  const detail = await getEventDetail(replayId);
  publishRelayboardUpdate();
  return detail;
}

export async function getEventFeed(status?: EventStatus) {
  return listEvents(status);
}

export async function getDashboardMetrics() {
  const rows = await listEvents();
  const metrics: Record<EventStatus | "total", number> = {
    total: rows.length,
    received: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    pending_approval: 0,
  };
  for (const row of rows) metrics[row.status] += 1;
  return metrics;
}

function demoPayload(source: EventSource): RelayboardIngress {
  const idempotencyKey = `demo_${randomUUID()}`;
  if (source === "form_submission") return { source, idempotencyKey, maxRetries: 3, payload: { fullName: "Avery Morgan", email: "avery@example.test", message: "Requesting an implementation review." } };
  if (source === "payment") return { source, idempotencyKey, maxRetries: 3, payload: { paymentId: `pay_${randomUUID().slice(0, 8)}`, amount: 249.5, currency: "USD" } };
  if (source === "telegram_message") return { source, idempotencyKey, maxRetries: 3, payload: { chatId: "tg_1842", messageId: `msg_${randomUUID().slice(0, 8)}`, text: "Please review this reply before sending." } };
  return { source, idempotencyKey, maxRetries: 3, payload: { endpoint: "/partner/orders", statusCode: 503, error: "Synthetic downstream timeout" } };
}

export async function generateDemoEvent(source: EventSource) {
  const payload = JSON.stringify(demoPayload(source));
  return ingestWebhookRaw(payload, signWebhookPayload(payload));
}
