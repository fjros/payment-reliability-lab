# HTTP and provider contracts

Implemented contract. The machine-readable version is [openapi.json](openapi.json), generated from the server's own validation schemas (`npm run openapi`; a unit test fails when it is stale). All service endpoints are local demo endpoints. No production authentication is claimed.

## Transfer API

`POST /v1/transfers`

- Require an `Idempotency-Key` (1–128 bounded printable characters) and an explicit `X-Demo-Account` from a seeded allowlist. This header is a local identity stub, not a security design for real customers.
- Body: `{ "asset": "DEMO_USD", "amountMinor": "1250", "destination": "demo:merchant-1", "note": "optional synthetic text" }`.
- Destination must be a seeded symbolic ID, never a URL supplied to the worker. Reject unknown fields and unbounded strings; notes at most 512 characters.
- New acceptance: `202` with `{ "transferId": "…", "accepted": true, "statusUrl": "/v1/transfers/…" }` after durable commit. It means accepted locally, not paid externally.
- Same scoped key and economic payload: replay the same acceptance body, including after process restart or settlement. Read current state through GET. Ancillary note is first-write-wins and excluded from the economic fingerprint; document this explicitly.
- Same scoped key with changed economic payload: `409 IDEMPOTENCY_CONFLICT`, without creating or modifying a transfer.
- Invalid request: `400 INVALID_REQUEST`; insufficient available funds: `409 INSUFFICIENT_FUNDS`; missing demo identity: `401`; inaccessible transfer: `404`.
- For this demo, rejection before acceptance does not reserve the key. Document that a later retry can be accepted if funds become available.

`GET /v1/transfers/:id`: current state, exact amount/asset, destination, provider reference, timestamps and last known external observation. Enforce demo-account scoping. Separate local state from last observed provider state and its age.

`GET /v1/transfers/:id/trace`: bounded, cursor-paginated event history with stable IDs, per-transfer sequence and causation/correlation IDs. A timestamp alone does not establish causality.

Additional read-only endpoints added during implementation (same account scoping, same error envelope): `GET /v1/transfers` (cursor-paginated list for the demo account), `GET /v1/transfers/:id/evidence` (linked journal batches and postings, provider attempts, provider observations, webhook events with their deliveries; each list capped at 200 with a `truncated` flag), `GET /v1/transfers/:id/invariants` (I1–I8 as pass/fail/unknown with evidence IDs) and `GET /v1/balances` (available, reserved, run clearing). A replayed acceptance carries the response header `Idempotent-Replayed: true`. Oversized bodies return `413 PAYLOAD_TOO_LARGE`.

`GET /v1/exceptions`: bounded read-only listing of unresolved outcomes, conflicting observations and invariant failures. Mark these as distinct categories; being unresolved need not violate correctness.

Use consistent error envelopes `{ "error": { "code": "…", "message": "…", "requestId": "…" } }`. Return no credentials or raw stack traces. Bound body sizes and pagination (default 25, max 100). Versioning: breaking changes would get a new `/v2` prefix. Clients must ignore unknown response fields and tolerate unknown enum values (new states, trace types or provider statuses); the application itself gives an unrecognized provider status no evidential weight. This v1 demo does not claim mobile client compatibility at scale.

## Webhooks

`POST /v1/provider/webhooks`: simulator-signed envelope with event ID, provider reference, status, provider sequence and occurrence time. Header `X-Provider-Signature: t=<unix seconds>,v1=<hex>` where `v1` is HMAC-SHA256 over the bytes of `<t>.<raw body>` with the local demo secret; tolerance 300 seconds either way; constant-time comparison; freshness is checked only after authenticity. Verify before accepting, bound payloads, compare signatures safely and reject expired envelopes. Transport signing time is fresh on redelivery; business occurrence time can be older. Inject a clock in tests.

Durably persist the inbox event before acknowledging `202`. If persistence fails, return a retriable failure. An exact duplicate can be acknowledged after verifying its committed identity. A reused event ID with different payload is conflicting evidence, not an invisible overwrite. Business transition deduplication must also handle different event IDs describing the same outcome.

Process the inbox asynchronously. In one transaction apply the valid transition, journal effect, trace and processing marker. Preserve ignored stale observations in the audit trace. Check correlation to a real transfer and expected amount/asset/destination before settlement. Route contradictions to exceptions without automatic balance correction.

## Provider simulator

`POST /provider/transfers` accepts a stable `providerReference` and exact economic request. Enforce unique references and payload comparison in persistent provider state. Repeating a reference returns the same provider operation; mismatched data is a conflict. It may return pending, completed or a final rejection that explicitly guarantees no external effect.

`GET /provider/transfers/:reference` returns its authoritative state or not-found. For recovery tests it may be unavailable or temporarily inconclusive. A local worker must not conclude that a lookup outage or a missing result means rejected.

Responses echo the economic fields, a `providerSequence`, and `finalNoEffect` (true only for a final rejection). `201` for a new operation, `200` for a repeated reference, `409 REFERENCE_CONFLICT` for mismatched data, `503` or a `200` with `status: "inconclusive"` when lookup is made unhelpful. Fault plans are rows in the provider database written by the scenario harness; **no fault-control HTTP route exists**.

The simulator supports deterministic modes: normal completion; response lost after durable acceptance; controlled pending outcome; final rejection; duplicate webhook delivery; older event after completion; terminal conflict. Control these via the scenario harness, outside the normal transfer request contract. Prevent fault controls from becoming general application API features.

## Trace vocabulary

Implemented types: `request_accepted`, `request_replayed`, `idempotency_conflict_rejected`, `funds_reserved`, `job_scheduled`, `job_claimed`, `submission_attempted`, `response_lost`, `provider_call_failed`, `outcome_unknown`, `lookup_attempted`, `provider_observation_received`, `webhook_accepted`, `duplicate_ignored` (delivery level or business-outcome level), `stale_event_ignored`, `state_changed`, `funds_settled`, `funds_released`, `exception_recorded`, `stale_worker_result_discarded`, `fault_injected` (harness, client-side faults only). Authoritative `facts` and raw `untrusted` text are separate fields.

At minimum: request accepted, funds reserved, job claimed, submission attempted, response lost, outcome unknown, lookup attempted, provider observation received, webhook accepted, duplicate ignored, stale event ignored, funds settled/released, exception recorded. Each record carries an event ID, transfer ID, timestamp, source, correlation/causation, and structured facts. Separate raw untrusted notes from authoritative fields.
