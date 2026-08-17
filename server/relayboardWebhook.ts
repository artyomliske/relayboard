import type { Express, Request, Response } from "express";
import express from "express";
import { ZodError } from "zod";
import { ingestWebhookRaw, verifyWebhookSignature } from "./relayboard";

export function registerRelayboardWebhook(app: Express) {
  app.post("/api/webhooks/events", express.raw({ type: "application/json", limit: "1mb" }), async (req: Request, res: Response) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const signature = req.header("x-relay-signature") ?? undefined;
    if (!rawBody) return res.status(400).json({ error: "A JSON payload is required" });
    if (!verifyWebhookSignature(rawBody, signature)) return res.status(401).json({ error: "Webhook signature is invalid" });

    try {
      const result = await ingestWebhookRaw(rawBody, signature);
      return res.status(result.deduplicated ? 200 : 202).json({
        id: result.event.id,
        correlationId: result.event.correlationId,
        deduplicated: result.deduplicated,
        status: result.detail?.event.status,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Webhook could not be accepted";
      const clientError = error instanceof ZodError || error instanceof SyntaxError;
      return res.status(clientError ? 400 : 500).json({ error: message });
    }
  });
}
