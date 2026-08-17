# Relayboard Domain Model

## Event

An event represents one accepted webhook payload. It is uniquely identified by its source and idempotency key, is assigned a correlation ID, and owns the processing lifecycle.

| Field | Purpose |
|---|---|
| `id` | Internal event identifier. |
| `source` | Synthetic event source: `form_submission`, `payment`, `telegram_message`, or `downstream_api_failure`. |
| `idempotencyKey` | Duplicates are rejected within the source boundary. |
| `correlationId` | Traces one execution; replay creates a new value. |
| `status` | Exactly one of `received`, `processing`, `completed`, `failed`, or `pending_approval`. |
| `payload` | Original accepted JSON payload. |
| `maskedPayload` | Payload rendered with sensitive values redacted. |
| `retryCount` | Number of recorded processing attempts. |
| `maxRetries` | Maximum permitted processing attempts. |
| `nextRetryAt` | Exponential-backoff time for a failed retriable event. |
| `replayOfEventId` | Source event when the event is a replay. |

## Processing attempt

Each processing attempt belongs to one event and records its outcome. A failed attempt schedules the next attempt with exponential backoff until `maxRetries` is reached; the final failed event is present in the dead-letter queue.

## Approval

An approval exists only while an event is `pending_approval`. An operator writes a comment and chooses approve or reject. Approval resumes processing; rejection finishes the event as `failed` and records the decision.

## Audit record

Every accepted event, state transition, processing attempt, replay and approval decision writes an immutable audit record. Audit records are ordered by timestamp and displayed in the event timeline.

## State transition contract

```text
received → processing
processing → completed | failed | pending_approval
pending_approval → processing | failed
failed → processing (replay creates a distinct event)
completed → processing (replay creates a distinct event)
```

No transition may overwrite the original payload, idempotency key, correlation ID, processing attempt history, or audit history.
