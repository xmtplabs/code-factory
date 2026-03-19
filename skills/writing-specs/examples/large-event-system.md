# Design Doc: Distributed Event Pipeline

## 1. Summary

This project introduces a distributed event pipeline that ingests events via an HTTP API, fans them out to multiple subscribers using a pub/sub pattern, and guarantees at-least-once delivery with configurable exponential backoff retry. Events that exhaust their retry budget are routed to a dead letter queue (DLQ) for manual inspection and replay. All events are persisted in SQLite (via `bun:sqlite`) with TTL-based cleanup to bound storage growth. The system is designed for single-node deployment serving up to 10,000 events per second with p99 ingestion latency under 50ms.

## 2. Project Goals & Non-Goals

**Goals:**

- At-least-once delivery guarantee: every ingested event SHALL be delivered to every active subscriber or moved to the DLQ
- Event ordering within a single partition key SHALL be preserved during fan-out
- Configurable retry with exponential backoff: base delay, max delay, max attempts, and jitter factor per subscription
- DLQ stores the original event, all delivery attempt metadata, and the final error for each failed delivery
- TTL-based cleanup removes delivered events older than a configurable threshold (default 72 hours)
- Ingestion endpoint returns a durable event ID synchronously; delivery happens asynchronously

**Non-Goals:**

- Exactly-once delivery (consumers must be idempotent)
- Cross-region replication or multi-node coordination
- Event transformation or filtering at the broker level
- Backpressure signaling to producers
- Web UI for DLQ inspection (CLI tooling only)

## 3. Context

**Catalysts:**
- GitHub Issue #142: "Need reliable internal event bus for audit and sync workflows"

**Codebase:**
- `src/api/` — existing HTTP server (Bun.serve)
- `src/db/` — SQLite connection helpers and migration runner
- `src/lib/queue.ts` — simple in-memory queue (to be replaced)

**External docs:**
- [Bun SQLite docs](https://bun.sh/docs/api/sqlite)
- [Exponential backoff (AWS architecture blog)](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)

**Impact area:**
- New: `src/events/` (ingestion, fan-out, delivery, DLQ, cleanup)
- Modified: `src/api/routes.ts` (new `/events` endpoint), `src/db/migrations/` (new tables)

## 4. System Design

**Architecture overview:**

Producer -> HTTP API (`POST /events`) -> `ingest()` -> SQLite `events` table -> `fanOut()` spawns `deliver()` per subscription -> on success, mark delivered -> on failure, schedule `retry()` with backoff -> after max attempts, `moveToDLQ()`. Separately, `cleanup()` runs on a configurable interval and deletes delivered events past their TTL.

**Interfaces:**

```typescript
interface Event {
  id: string;               // ULID
  partitionKey: string;
  type: string;
  payload: Uint8Array;      // max 256 KB
  createdAt: number;        // Unix ms
}

interface Subscription {
  id: string;
  eventTypes: string[];     // filter by event type, empty = all
  endpointUrl: string;
  retryPolicy: RetryPolicy;
  active: boolean;
}

interface DeliveryAttempt {
  eventId: string;
  subscriptionId: string;
  attemptNumber: number;
  status: "pending" | "success" | "failed";
  httpStatus: number | null;
  error: string | null;
  attemptedAt: number;
}

interface RetryPolicy {
  maxAttempts: number;       // default 5
  baseDelayMs: number;       // default 1000
  maxDelayMs: number;        // default 30000
  jitterFactor: number;      // 0-1, default 0.2
}
```

**Key functions:**

- `ingest(event): string` — validates payload size (max 256 KB), assigns ULID, persists to `events` table, triggers `fanOut()`, returns event ID
- `fanOut(eventId): void` — queries active subscriptions matching event type, creates `DeliveryAttempt` rows, calls `deliver()` for each
- `deliver(attempt): void` — POSTs event payload to subscriber endpoint with 10s timeout, updates attempt status
- `retry(attempt): void` — computes next delay as `min(baseDelay * 2^attempt * (1 + random * jitter), maxDelay)`, schedules re-delivery
- `moveToDLQ(attempt): void` — copies event and all attempts to `dead_letter_queue` table, marks subscription delivery as terminal
- `cleanup(): void` — deletes events from `events` table where status is fully delivered and `createdAt < now - ttl`

## 5. Libraries & Utilities Required

**External dependencies:**

| Package | Version | Purpose |
|---------|---------|---------|
| `ulid` | `^2.3.0` | Sortable, unique event IDs with timestamp encoding |

**Internal modules:**

| Module | Path | Purpose |
|--------|------|---------|
| `db` | `src/db/` | SQLite connection pool and migration runner |
| `api` | `src/api/` | HTTP server and route registration |

No additional external dependencies required. `bun:sqlite` is a built-in Bun module.

## 6. Testing & Validation

### Acceptance Criteria

1. WHEN a valid event is POSTed to `/events` THE SYSTEM SHALL persist it to SQLite and return HTTP 202 with the event ID within 50ms at p99
2. WHEN an event is ingested THE SYSTEM SHALL create one `DeliveryAttempt` row per active matching subscription within 100ms
3. WHEN a subscriber endpoint returns HTTP 2xx THE SYSTEM SHALL mark the delivery attempt as `success`
4. WHEN a subscriber endpoint returns HTTP 5xx THE SYSTEM SHALL schedule a retry using exponential backoff
5. WHEN a delivery attempt is retried THE SYSTEM SHALL compute delay as `min(baseDelay * 2^attempt * (1 + random * jitter), maxDelay)`
6. WHEN a delivery attempt reaches `maxAttempts` AND the final attempt fails THE SYSTEM SHALL move the event to the DLQ
7. THE SYSTEM SHALL preserve event ordering for events sharing the same partition key during fan-out to a single subscriber
8. WHEN 100 concurrent events are ingested simultaneously THE SYSTEM SHALL persist all 100 without data loss or SQLite locking errors
9. WHILE a subscriber endpoint is unreachable THE SYSTEM SHALL continue delivering events to all other subscribers without delay
10. WHEN an event is moved to the DLQ THE SYSTEM SHALL store the original payload, all attempt records, and the final error message
11. THE SYSTEM SHALL delete delivered events older than the configured TTL when `cleanup()` runs
12. THE SYSTEM SHALL NOT delete events from the `events` table that have any pending or in-progress delivery attempts, regardless of TTL
13. WHEN an event with an empty payload is ingested THE SYSTEM SHALL accept it and deliver it normally
14. WHEN an event payload exceeds 256 KB THE SYSTEM SHALL reject it with HTTP 413 and a descriptive error
15. WHEN a duplicate event ID is submitted THE SYSTEM SHALL return HTTP 409 without creating a second record
16. THE SYSTEM SHALL NOT expose internal stack traces or database errors in HTTP responses

### Edge Cases

- **Race condition: cleanup vs. delivery** — `cleanup()` acquires a row-level lock and checks delivery status inside the same transaction, preventing deletion of events with in-flight attempts.
- **Concurrent writes** — SQLite WAL mode is enabled to allow concurrent reads during writes. `ingest()` uses `IMMEDIATE` transactions to fail fast on contention.
- **Subscriber timeout** — `deliver()` enforces a 10-second timeout. Timeouts are treated as failures and follow the retry path.
- **DLQ overflow** — DLQ entries have their own TTL (default 30 days). `cleanup()` prunes expired DLQ entries in the same pass.

### Verification Commands

```bash
bun test src/events/ --coverage
bun test src/events/delivery.test.ts    # retry timing assertions
bun test src/events/dlq.test.ts         # DLQ routing and storage
bun test src/events/cleanup.test.ts     # TTL and race condition tests
bun run lint
bun run typecheck
```
