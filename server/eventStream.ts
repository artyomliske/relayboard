import type { Express, Request, Response } from "express";

type StreamListener = () => void;
const listeners = new Set<StreamListener>();

export function publishRelayboardUpdate() {
  listeners.forEach(listener => listener());
}

export function registerRelayboardEventStream(app: Express) {
  app.get("/api/events/stream", (req: Request, res: Response) => {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const notify = () => res.write(`event: relayboard\ndata: {"updatedAt":"${new Date().toISOString()}"}\n\n`);
    listeners.add(notify);
    notify();

    req.on("close", () => listeners.delete(notify));
  });
}
