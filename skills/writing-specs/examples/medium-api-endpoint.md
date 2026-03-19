# Design Doc: POST /api/v1/webhooks

## 1. Summary

Add a `POST /api/v1/webhooks` endpoint that lets users register callback URLs for event notifications. Requests are authenticated via API key, rate-limited to 100 requests per minute per key, and webhook records are persisted in SQLite. This builds on the existing Bun-based HTTP server and auth middleware.

## 2. Project Goals & Non-Goals

**Goals:**

- Accept and validate webhook registration requests with a target URL and event types
- Authenticate every request using an `X-API-Key` header against stored keys
- Enforce a rate limit of 100 requests per minute per API key, returning HTTP 429 when exceeded
- Persist webhook registrations in SQLite with created/updated timestamps

**Non-Goals:**

- Delivering webhook events to registered URLs (separate project)
- Supporting batch registration of multiple webhooks in a single request
- Providing a management UI for webhook CRUD operations
- Webhook signature verification or retry logic

## 3. Context

- **Catalyst:** [GitHub Issue #142](https://github.com/org/repo/issues/142) - Customer request for programmatic webhook registration
- **Codebase:**
  - `src/server.ts` - Bun HTTP server entrypoint
  - `src/middleware/auth.ts` - Existing API key validation
  - `src/db/connection.ts` - SQLite connection setup
- **External docs:** [Bun SQLite docs](https://bun.sh/docs/api/sqlite)

## 4. System Design

```typescript
interface WebhookRecord {
  id: string;
  apiKeyId: string;
  url: string;
  events: string[];
  createdAt: string;
}

interface CreateWebhookRequest {
  url: string;
  events: string[];
}

interface CreateWebhookResponse {
  id: string;
  url: string;
  events: string[];
  createdAt: string;
}
```

**API contract:** `POST /api/v1/webhooks` accepts `CreateWebhookRequest` as JSON, requires `X-API-Key` header, returns `201` with `CreateWebhookResponse` on success.

**Key functions:**

- `registerWebhook(req: CreateWebhookRequest, apiKeyId: string): WebhookRecord` - Validates input, generates UUID, inserts into SQLite, returns the record.
- `checkRateLimit(apiKeyId: string): boolean` - Returns `true` if the key has remaining quota in the current window.

## 5. Libraries & Utilities Required

**External dependencies:**

| Package | Version | Purpose |
|---------|---------|---------|
| `bun:sqlite` | built-in | Webhook record persistence |
| `rate-limiter-flexible` | `^5.0.0` | Sliding-window rate limiting per API key |

**Internal modules:**

| Module | Path | Purpose |
|--------|------|---------|
| `auth` | `src/middleware/auth.ts` | API key extraction and validation |
| `db` | `src/db/connection.ts` | Shared SQLite connection instance |

## 6. Testing & Validation

### Acceptance Criteria

1. WHEN a valid `CreateWebhookRequest` is sent with a valid API key THE SYSTEM SHALL return HTTP 201 with the created webhook record.
2. WHEN the `X-API-Key` header is missing THE SYSTEM SHALL return HTTP 401 with error code `AUTH_REQUIRED`.
3. WHEN the `X-API-Key` header contains an invalid key THE SYSTEM SHALL return HTTP 403 with error code `INVALID_KEY`.
4. WHEN an API key exceeds 100 requests in a 60-second window THE SYSTEM SHALL return HTTP 429 with a `Retry-After` header.
5. WHEN the `url` field is missing or not a valid HTTPS URL THE SYSTEM SHALL return HTTP 400 with error code `INVALID_URL`.
6. WHEN the `events` array is empty or contains unrecognized event types THE SYSTEM SHALL return HTTP 400 with error code `INVALID_EVENTS`.
7. THE SYSTEM SHALL persist the webhook record in SQLite before returning the 201 response.
8. THE SYSTEM SHALL NOT expose internal database IDs or stack traces in error responses.
9. WHEN a webhook is created THE SYSTEM SHALL return a response within 100ms at p99 under normal load.
10. THE SYSTEM SHALL assign a unique UUID v4 identifier to each webhook record.

### Edge Cases

- **Rate limiting race conditions:** Two concurrent requests from the same key arriving at request 100 SHALL NOT both succeed; the rate limiter uses atomic increment operations.
- **Auth failures:** Expired, revoked, or malformed API keys SHALL all produce HTTP 403, never leak key validity timing via response delays.
- **Malformed input:** Non-JSON bodies, unexpected content types, and oversized payloads (>1MB) SHALL return HTTP 400 without processing.

### Verification Commands

```bash
bun test src/routes/webhooks/
bun run lint
bun run typecheck
```
