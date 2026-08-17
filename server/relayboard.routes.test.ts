import express from "express";
import { createServer } from "http";
import { afterEach, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { events } from "../drizzle/schema";
import { getDb } from "./db";
import type { TrpcContext } from "./_core/context";
import { appRouter } from "./routers";
import { signWebhookPayload } from "./relayboard";
import { registerRelayboardWebhook } from "./relayboardWebhook";

const eventIds: string[] = [];

async function withWebhookServer<T>(run: (baseUrl: string) => Promise<T>) {
  const app = express();
  registerRelayboardWebhook(app);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to resolve webhook test server address");

  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
}

function validWebhook(suffix: string) {
  return {
    source: "form_submission",
    idempotencyKey: `route-${suffix}`,
    maxRetries: 2,
    payload: { fullName: "Route Test", email: "route@example.test", message: "Validate the endpoint" },
  };
}

async function postWebhook(baseUrl: string, body: unknown, signature?: string) {
  const raw = JSON.stringify(body);
  return fetch(`${baseUrl}/api/webhooks/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-relay-signature": signature ?? signWebhookPayload(raw) },
    body: raw,
  });
}

afterEach(async () => {
  const db = await getDb();
  if (db && eventIds.length) await db.delete(events).where(inArray(events.id, eventIds.splice(0)));
});

describe("POST /api/webhooks/events", () => {
  it("accepts a valid HMAC request once and reports idempotent duplicate acceptance", async () => {
    await withWebhookServer(async baseUrl => {
      const body = validWebhook(crypto.randomUUID());
      const first = await postWebhook(baseUrl, body);
      const firstResult = (await first.json()) as { id: string; deduplicated: boolean; status: string };
      eventIds.push(firstResult.id);
      const duplicate = await postWebhook(baseUrl, body);
      const duplicateResult = (await duplicate.json()) as { id: string; deduplicated: boolean };

      expect(first.status).toBe(202);
      expect(firstResult).toMatchObject({ deduplicated: false, status: "completed" });
      expect(duplicate.status).toBe(200);
      expect(duplicateResult).toMatchObject({ id: firstResult.id, deduplicated: true });
    });
  });

  it("rejects invalid signatures and signed schema-invalid payloads", async () => {
    await withWebhookServer(async baseUrl => {
      const invalidSignature = await postWebhook(baseUrl, validWebhook(crypto.randomUUID()), "0".repeat(64));
      expect(invalidSignature.status).toBe(401);

      const invalidPayload = { ...validWebhook(crypto.randomUUID()), payload: { fullName: "Route Test", email: "not-an-email", message: "" } };
      const invalidSchema = await postWebhook(baseUrl, invalidPayload);
      expect(invalidSchema.status).toBe(400);
    });
  });
});

describe("Relayboard tRPC actions", () => {
  it("generates a demo event, records approval, and replays through the request layer", async () => {
    const caller = appRouter.createCaller({} as TrpcContext);
    const generated = await caller.relayboard.generateDemo({ source: "telegram_message" });
    eventIds.push(generated.event.id);
    expect(generated.detail?.event.status).toBe("pending_approval");

    const approved = await caller.relayboard.decideApproval({
      eventId: generated.event.id,
      decision: "approved",
      comment: "Approved by route-level test",
    });
    expect(approved?.event.status).toBe("completed");

    const completed = await caller.relayboard.generateDemo({ source: "form_submission" });
    eventIds.push(completed.event.id);
    const replay = await caller.relayboard.replay({ eventId: completed.event.id });
    if (replay) eventIds.push(replay.event.id);
    expect(replay?.event.replayOfEventId).toBe(completed.event.id);
    expect(replay?.audit.some(record => record.action === "side_effect_skipped")).toBe(true);
  });
});
