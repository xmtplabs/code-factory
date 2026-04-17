# Design Doc: Webhook Delivery Retry Logic

## Summary

The existing webhook system handles registration and single-attempt delivery. This change adds exponential backoff retry logic for failed deliveries, with a dead-letter queue for permanently failed webhooks.

## Project Goals & Non-Goals

**Goals:**
- Retry failed webhook deliveries up to 5 times with exponential backoff (1s, 2s, 4s, 8s, 16s)
- Move permanently failed webhooks to a dead-letter table for manual inspection
- Preserve existing webhook registration and single-delivery behavior

**Non-Goals:**
- Webhook payload transformation or filtering
- Real-time delivery status dashboard
- Configurable retry policies per webhook

## Context

- **Catalysts:** Customer reports of missed webhook notifications when downstream services have brief outages
- **Codebase:**
  - `src/webhooks/sender.ts` — current single-attempt delivery logic
  - `src/webhooks/registry.ts` — webhook registration and management
  - `src/webhooks/types.ts` — webhook data types
  - `tests/webhooks/sender.test.ts` — delivery tests (12 existing test cases)
  - `tests/webhooks/registry.test.ts` — registration tests (8 existing test cases)
- **External docs:** None
- **Impact area:** `src/webhooks/`, `src/database/migrations/`

- **Brownfield gap analysis:**
  - `src/webhooks/sender.ts` — exports `sendWebhook(url, payload)` returning `Promise<boolean>`. New retry logic wraps this function. Must not change its signature or behavior for successful deliveries.
  - `src/webhooks/registry.ts` — exports `registerWebhook()`, `removeWebhook()`, `listWebhooks()`. Not modified by this change but the registry's `WebhookConfig` type gains an optional `retryPolicy` field in a future iteration (non-goal for now).
  - `src/webhooks/types.ts` — defines `WebhookPayload`, `WebhookConfig`, `DeliveryResult`. Will be extended with `RetryState` and `DeadLetterEntry` types.
  - Existing test coverage: `tests/webhooks/sender.test.ts` covers successful delivery, network errors, timeout handling, and invalid URLs. No coverage for retry behavior (doesn't exist yet).

- **Existing behavior at risk:** Single-attempt delivery timing — current system delivers webhooks immediately with no queue. Retry logic must not delay initial delivery attempts.

## System Design

**Architecture:** Add a `RetryScheduler` that wraps the existing `sendWebhook` function. On failure, it enqueues a retry job with exponential backoff. After max retries, it writes to a `dead_letter_webhooks` table.

**New interfaces:**

```typescript
interface RetryState {
  webhookId: string;
  attempt: number;
  maxAttempts: number;
  nextRetryAt: Date;
  lastError: string;
}

interface DeadLetterEntry {
  webhookId: string;
  payload: WebhookPayload;
  lastError: string;
  failedAt: Date;
  attempts: number;
}
```

**Key functions:**

- `retryWebhook(webhookId, state): Promise<DeliveryResult>` — attempts delivery, updates retry state
- `scheduleRetry(webhookId, attempt): void` — enqueues next retry with exponential backoff
- `moveToDeadLetter(webhookId, payload, error): void` — writes to dead-letter table

**Alternatives considered:**
- External queue service (RabbitMQ/SQS) — rejected: adds infrastructure dependency for a simple retry loop
- Database-backed job queue — selected: leverages existing PostgreSQL, no new infrastructure

## Libraries & Utilities Required

**External dependencies:**

None.

**Internal modules:**

| Module | Path | Purpose |
|--------|------|---------|
| `sendWebhook` | `src/webhooks/sender.ts` | Existing delivery function — wrapped by retry logic |
| `db` | `src/database/client.ts` | Database client for dead-letter table |

## Testing & Validation

### Acceptance Criteria

- WHEN a webhook delivery fails with a retryable error THE SYSTEM SHALL schedule a retry with exponential backoff.
- WHEN a webhook delivery succeeds on retry THE SYSTEM SHALL mark the webhook as delivered and stop retrying.
- WHEN a webhook delivery fails after 5 retry attempts THE SYSTEM SHALL move the webhook to the dead-letter table.
- WHEN a webhook delivery fails with a non-retryable error (HTTP 4xx) THE SYSTEM SHALL move it to dead-letter immediately without retrying.
- THE SYSTEM SHALL NOT delay the initial delivery attempt — first attempt must be immediate.

### Regression Protection

- THE SYSTEM SHALL CONTINUE TO deliver webhooks successfully on the first attempt when the downstream service is healthy.
  Verification anchor: `tests/webhooks/sender.test.ts` ("delivers webhook successfully")
- THE SYSTEM SHALL CONTINUE TO return a timeout error when the downstream service does not respond within 10 seconds.
  Verification anchor: `tests/webhooks/sender.test.ts` ("times out after 10 seconds")
- THE SYSTEM SHALL CONTINUE TO handle invalid URLs gracefully.
  Verification anchor: `tests/webhooks/sender.test.ts` ("rejects invalid webhook URL")

### Edge Cases

- Concurrent retries for the same webhook (should not occur — scheduler must deduplicate)
- Database unavailable when writing to dead-letter (should retry the dead-letter write)
- Webhook deleted from registry while retries are pending (should stop retrying)

### Verification Commands

```bash
npm test -- tests/webhooks/
npm run lint
npm run typecheck
```
