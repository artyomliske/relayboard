import { afterEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { events } from "../drizzle/schema";
import { getDb, getEvent, updateEvent } from "./db";
import { decideApproval, ingestWebhookRaw, replayEvent, signWebhookPayload } from "./relayboard";
import { createRetryWorker, runRetryWorkerCycle } from "./retryWorker";

const eventIds: string[] = [];

function payload(source: "form_submission" | "telegram_message" | "downstream_api_failure", suffix: string, maxRetries = 3) {
  if (source === "form_submission") {
    return { source, idempotencyKey: `test-form-${suffix}`, maxRetries, payload: { fullName: "Test Operator", email: "test@example.test", message: "Lifecycle assertion" } };
  }
  if (source === "telegram_message") {
    return { source, idempotencyKey: `test-telegram-${suffix}`, maxRetries, payload: { chatId: `test-chat-${suffix}`, messageId: `test-message-${suffix}`, text: "Review this synthetic message" } };
  }
  return { source, idempotencyKey: `test-failure-${suffix}`, maxRetries, payload: { endpoint: "/test/downstream", statusCode: 503, error: "Synthetic test failure" } };
}

async function ingest(input: ReturnType<typeof payload>) {
  const raw = JSON.stringify(input);
  const result = await ingestWebhookRaw(raw, signWebhookPayload(raw));
  eventIds.push(result.event.id);
  return result;
}

afterEach(async () => {
  const db = await getDb();
  if (db && eventIds.length) await db.delete(events).where(inArray(events.id, eventIds.splice(0)));
});

describe("Relayboard persisted event lifecycle", () => {
  it("deduplicates a signed event and completes it exactly once", async () => {
    const input = payload("form_submission", crypto.randomUUID());
    const first = await ingest(input);
    const raw = JSON.stringify(input);
    const duplicate = await ingestWebhookRaw(raw, signWebhookPayload(raw));

    expect(first.detail?.event.status).toBe("completed");
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.event.id).toBe(first.event.id);
  });

  it("pauses a Telegram message for written approval and resumes it when approved", async () => {
    const result = await ingest(payload("telegram_message", crypto.randomUUID()));
    expect(result.detail?.event.status).toBe("pending_approval");

    const decided = await decideApproval(result.event.id, "approved", "Reviewed for safe continuation", "Test Operator");
    expect(decided?.event.status).toBe("completed");
    expect(decided?.approvals[0]?.decision).toBe("approved");
  });

  it("sends an exhausted downstream failure to the dead-letter queue", async () => {
    const result = await ingest(payload("downstream_api_failure", crypto.randomUUID(), 1));
    expect(result.detail?.event.status).toBe("failed");
    expect(result.detail?.event.retryCount).toBe(1);
    expect(result.detail?.event.isDeadLetter).toBe(true);
  });

  it("processes a due retry through the persistent worker cycle", async () => {
    const result = await ingest(payload("downstream_api_failure", crypto.randomUUID(), 2));
    await updateEvent(result.event.id, { nextRetryAt: new Date(Date.now() - 1_000) });

    const cycle = await runRetryWorkerCycle();
    const event = await getEvent(result.event.id);
    expect(cycle.processed).toBeGreaterThanOrEqual(1);
    expect(event?.retryCount).toBe(2);
    expect(event?.isDeadLetter).toBe(true);
  });

  it("starts an autonomous worker that advances a due event without a manual cycle call", async () => {
    const result = await ingest(payload("downstream_api_failure", crypto.randomUUID(), 2));
    await updateEvent(result.event.id, { nextRetryAt: new Date(Date.now() - 1_000) });
    const worker = createRetryWorker(runRetryWorkerCycle, () => 0 as unknown as ReturnType<typeof setTimeout>);

    await worker.start();
    worker.stop();

    const event = await getEvent(result.event.id);
    expect(event?.retryCount).toBe(2);
    expect(event?.isDeadLetter).toBe(true);
  });

  it("replays a completed event under a new correlation ID", async () => {
    const original = await ingest(payload("form_submission", crypto.randomUUID()));
    const replay = await replayEvent(original.event.id);
    if (replay) eventIds.push(replay.event.id);

    expect(replay?.event.replayOfEventId).toBe(original.event.id);
    expect(replay?.event.correlationId).not.toBe(original.detail?.event.correlationId);
    expect(replay?.event.operationKey).toBe(original.detail?.event.operationKey);
    expect(replay?.event.status).toBe("completed");
    expect(replay?.audit.some(record => record.action === "side_effect_skipped")).toBe(true);
  });
});
