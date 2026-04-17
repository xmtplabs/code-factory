# Bugfix Spec: Rate Limiter Over-Counting Requests After v5.1.0 Upgrade

## 1. Current Behavior

WHEN an API key makes a single request within a 60-second window THE SYSTEM incorrectly counts it as 2 requests toward the rate limit.

- **Steps to reproduce:**
  1. Send a single GET request to `/api/data` with a valid API key
  2. Check the rate limit headers in the response
  3. Observe `X-RateLimit-Remaining` shows 98 instead of 99 (limit is 100)
- **Actual output:** `X-RateLimit-Remaining: 98` after one request
- **Affected code path:** `src/middleware/rate-limiter.ts:34` — the `consume()` call was changed in the `rate-limiter-flexible` v5.1.0 upgrade to return a different response shape, and the points-consumed calculation now double-counts.
- **Environment:** Occurs in all environments after upgrading `rate-limiter-flexible` from v5.0.3 to v5.1.0.

## 2. Expected Behavior

- WHEN an API key makes its first request in a 60-second window THE SYSTEM SHALL count it as 1 request toward the 100-request limit.
- WHEN an API key has made exactly 100 requests in a 60-second window THE SYSTEM SHALL return HTTP 429 for the 101st request.
- THE SYSTEM SHALL NOT double-count requests when using the sliding window algorithm.

## 3. Unchanged Behavior

- THE SYSTEM SHALL CONTINUE TO return HTTP 429 with a `Retry-After` header when the rate limit is exceeded.
  Verification anchor: `tests/middleware/rate-limiter.test.ts` ("returns 429 with Retry-After header")
- THE SYSTEM SHALL CONTINUE TO reset the request count after the 60-second window expires.
  Verification anchor: `tests/middleware/rate-limiter.test.ts` ("resets count after window expiry")
- THE SYSTEM SHALL CONTINUE TO apply rate limits per API key, not globally.
  Verification anchor: `tests/middleware/rate-limiter.test.ts` ("isolates rate limits by API key")
