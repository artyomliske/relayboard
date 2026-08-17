# Relayboard

Relayboard is an operator-grade webhook event processing platform. It verifies signed ingress, deduplicates idempotency keys, tracks each event through `received`, `processing`, `completed`, `failed`, and `pending_approval`, and preserves a complete audit trail.

The application includes configurable retries with exponential backoff, a dead-letter queue, written operator approvals, safe event replay using a new correlation ID, sensitive-field masking, and a synthetic demo generator for form submissions, payments, Telegram messages, and downstream API failures.

## Development

```bash
pnpm install
pnpm test
pnpm check
pnpm dev
```

The production worker starts in an always-on runtime and processes due retries. Set `RELAYBOARD_WEBHOOK_SECRET` in the deployment environment before accepting live webhook traffic.

## GitHub Pages

The [`pages/`](pages/) directory is a static project page, deployed through the included GitHub Actions workflow. It intentionally does not contain the full Relayboard application: GitHub Pages cannot run the Node backend required for signed webhook ingestion, server-sent live updates, or the persistent retry worker.
