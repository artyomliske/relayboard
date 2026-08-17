import { describe, expect, it } from "vitest";
import { maskPayload, signWebhookPayload, verifyWebhookSignature } from "./relayboard";

describe("Relayboard webhook HMAC configuration", () => {
  it("validates the configured secret through a signed payload", () => {
    const secret = process.env.RELAYBOARD_WEBHOOK_SECRET;
    expect(secret, "RELAYBOARD_WEBHOOK_SECRET must be configured for the test runtime").toBeTruthy();
    const payload = JSON.stringify({ source: "form_submission", idempotencyKey: "test-key-0001", payload: { fullName: "Test", email: "test@example.test", message: "Hello" } });
    const signature = signWebhookPayload(payload, secret);
    expect(verifyWebhookSignature(payload, signature, secret)).toBe(true);
    expect(verifyWebhookSignature(payload, "0".repeat(64), secret)).toBe(false);
  });
});

describe("Relayboard payload masking", () => {
  it("redacts sensitive fields without changing ordinary values", () => {
    expect(maskPayload({ email: "operator@example.test", message: "Safe text", nested: { token: "secret" } })).toEqual({
      email: "[masked]",
      message: "Safe text",
      nested: { token: "[masked]" },
    });
  });
});
