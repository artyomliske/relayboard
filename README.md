# Relayboard

<p align="center">
  <strong>An operator-grade control plane for webhook event processing.</strong><br />
  Signed ingress, traceable lifecycle, human approvals, protected replay, and a live operational inbox.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#webhook-contract">Webhook contract</a> ·
  <a href="#quality">Quality</a>
</p>

<p align="center">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white" />
  <img alt="Express" src="https://img.shields.io/badge/Express-4-111827?logo=express&logoColor=white" />
  <img alt="MySQL compatible database" src="https://img.shields.io/badge/Database-MySQL%20%2F%20TiDB-4479A1?logo=mysql&logoColor=white" />
  <img alt="License MIT" src="https://img.shields.io/badge/License-MIT-72EDCE" />
</p>

> **Relayboard makes event processing observable and controllable.** It accepts verified webhooks, prevents duplicate ingress, traces every transition, and gives an operator the final say when a workflow needs human review.

![Relayboard operations dashboard: live event inbox, status lifecycle, synthetic demo event generator, and inspection panel](docs/screenshots/relayboard-dashboard.png)

## Why Relayboard

Webhook workflows often fail in the spaces between services: an event may be accepted twice, a downstream call may exhaust retries, or an irreversible step may require an operator decision. Relayboard makes those states explicit rather than leaving them inside opaque integration logs.

| Capability | What it provides |
| --- | --- |
| **Verified ingress** | HMAC signature verification, runtime schema validation, and idempotency-key deduplication before an event enters the inbox. |
| **Visible lifecycle** | Events move through `received` → `processing` → `completed` / `failed` / `pending_approval`, with a traceable state at every moment. |
| **Durable recovery** | Configurable retries use exponential backoff; exhausted events move into the dead-letter queue. |
| **Human control** | Operators can approve or reject paused events with a mandatory written comment that is retained in the audit trail. |
| **Protected replay** | A replay receives a new correlation ID while a durable operation key prevents a completed side effect from running twice. |
| **Safe inspection** | The detail view masks sensitive payload fields and combines processing attempts, approvals, and decisions in one timeline. |
| **Demonstrable workflows** | The UI generates exactly four synthetic sources: form submissions, payments, Telegram messages, and downstream API failures. |

## How it works

```mermaid
flowchart LR
  A[Incoming webhook] --> B{HMAC valid?}
  B -- no --> X[Reject]
  B -- yes --> C{New idempotency key?}
  C -- no --> D[Return existing event]
  C -- yes --> E[Event inbox: received]
  E --> F[processing]
  F --> G{Requires approval?}
  G -- yes --> H[pending_approval]
  H --> I{Operator decision}
  I -- approve --> F
  I -- reject --> J[failed]
  G -- no --> K{Processing result}
  K -- success --> L[completed]
  K -- failure + attempts left --> M[Exponential backoff]
  M --> F
  K -- exhausted --> N[failed + dead-letter queue]
  L --> O[Optional protected replay]
  N --> O
```

The React dashboard receives live updates through server-sent events. In the always-on production runtime, a persistent worker processes due retries. Each completed event claims a unique operation key; a replay retains that key, so the system records the replay while suppressing a duplicate side effect.

## Tech stack

| Layer | Technology |
| --- | --- |
| Dashboard | React 19, TypeScript, Tailwind CSS 4, tRPC, TanStack Query |
| API | Express 4, tRPC 11, Zod |
| Persistence | Drizzle ORM with MySQL-compatible storage (MySQL or TiDB) |
| Live operations | Server-sent events and an always-on Node retry worker |
| Quality | Vitest, TypeScript type checking, route-level webhook tests |

## Quick start

### Prerequisites

Use **Node.js 22+**, **pnpm 10+**, and a running MySQL-compatible database. The default development stack has been exercised with the scripts in `package.json`.

### 1. Clone and install

```bash
git clone https://github.com/artyomliske/relayboard.git
cd relayboard
corepack enable
pnpm install
```

### 2. Configure the environment

Create a local `.env` file and replace the placeholder values. Do not commit this file.

```dotenv
# Required for the persistence layer and Drizzle migrations.
DATABASE_URL="mysql://USER:PASSWORD@HOST:3306/relayboard"

# Required to verify x-relay-signature on incoming webhook requests.
RELAYBOARD_WEBHOOK_SECRET="replace-with-a-long-random-secret"
```

For the full authenticated dashboard, also configure the OAuth variables required by your deployment environment. The webhook endpoint itself requires the database connection and `RELAYBOARD_WEBHOOK_SECRET`.

### 3. Create the database schema

```bash
pnpm db:push
```

### 4. Run Relayboard

```bash
pnpm dev
```

Open the local URL printed by the development server. For production, use the standard build and start commands in an always-on Node runtime so that the retry worker and the SSE connections remain available.

```bash
pnpm build
NODE_ENV=production pnpm start
```

## Webhook contract

Relayboard receives JSON at `POST /api/webhooks/events`. Sign the **raw UTF-8 request body** using HMAC-SHA256 and send the hexadecimal digest in the `x-relay-signature` header.

```bash
payload='{
  "source": "form_submission",
  "idempotencyKey": "lead-2026-0001",
  "maxRetries": 3,
  "payload": {
    "fullName": "Ada Lovelace",
    "email": "ada@example.com",
    "message": "Request a demo"
  }
}'

signature=$(printf '%s' "$payload" \
  | openssl dgst -sha256 -hmac "$RELAYBOARD_WEBHOOK_SECRET" -hex \
  | sed 's/^.* //')

curl --request POST http://localhost:3000/api/webhooks/events \
  --header 'content-type: application/json' \
  --header "x-relay-signature: $signature" \
  --data "$payload"
```

| Field | Required | Notes |
| --- | --- | --- |
| `source` | Yes | One of `form_submission`, `payment`, `telegram_message`, or `downstream_api_failure`. |
| `idempotencyKey` | Yes | Uniquely identifies an event per source; duplicate deliveries return the existing event. |
| `maxRetries` | No | Maximum processing attempts; defaults to `3`. |
| `payload` | Yes | The source data to process; sensitive fields are masked in the operator view. |

The endpoint returns **202** for a newly accepted event, **200** for an idempotent duplicate, **400** for malformed or schema-invalid input, and **401** for an invalid signature.

## Operator workflows

The dashboard supports three operational decisions without leaving the event context:

1. **Review** a `pending_approval` event, add a written comment, then approve or reject it.
2. **Inspect** masked payload data, attempts, and the complete audit timeline for any event.
3. **Replay** a `completed` or `failed` event. Relayboard issues a new correlation ID but reuses the operation key to protect downstream side effects.

## Quality

```bash
pnpm test
pnpm check
```

The automated suite covers HMAC verification, payload masking, idempotency, status changes, approval decisions, retry/dead-letter behavior, autonomous worker execution, replay protection, webhook request responses, and public tRPC action paths.

## Project showcase

The static project landing page is published at [artyomliske.github.io/relayboard](https://artyomliske.github.io/relayboard/); its source remains in [`pages/`](pages/). It is intentionally separate from the application because a static host cannot run the Node backend required for signed ingestion, server-sent updates, or the persistent retry worker.

## License

Released under the [MIT License](LICENSE).
