# Domain, state and invariants

Normative v1 behavior, implemented in `src/domain/` and `src/app/` and enforced again by constraints in `migrations/app/`. If an implementation changes a representation, it must preserve these guarantees and update this document and its tests.

## Money and identity

Use one explicitly fake asset: `DEMO_USD`, scale 2. Accept positive integer minor-unit strings matching `^[1-9][0-9]*$`, bounded at 10^12 per transfer. Parse with `bigint` or exact decimal arithmetic; never through JavaScript `number`. Store exact integers in PostgreSQL and serialize amounts as decimal strings. No FX, fees or rounding policy is needed for v1; do not claim to demonstrate them. Reject fractional minor units, exponents, negatives, unsupported assets and overflow.

Every business operation has a durable `transfer_id`. Every provider submission reuses one durable `provider_reference` across worker retries. Delivery IDs, event IDs, HTTP request IDs and transfer IDs are different identities. Preserve that distinction in traces.

Every demo account belongs to a synthetic **run** (an isolated namespace used by scenarios and by the MCP scope). An idempotency key is scoped to `(demo_account, operation_kind, key)`. Fingerprint a canonical, validated business request: asset, amount and destination. The ancillary `note` is excluded from the fingerprint and is first-write-wins: a retry with a different note replays the original acceptance and keeps the original note, so a note can neither change nor conflict with the economic request. A unique DB constraint must resolve concurrent requests. In v1, retain keys indefinitely; there is no cleanup/reuse ambiguity.

## Transfer states

| Current | Evidence/action | Next | Journal effect |
|---|---|---|---|
| None | Valid accepted API request with enough available balance | `reserved` | Reserve once |
| `reserved` | Durable worker attempt created | `submitting` | None |
| `submitting` | Accepted response or provider lookup says pending | `provider_pending` | None |
| `submitting` | Response lost, deadline exceeded or recoverable crash | `outcome_unknown` | None |
| `outcome_unknown` | Authoritative lookup says pending | `provider_pending` | None |
| `outcome_unknown` | Lookup says *not found*: resubmit the **same** provider reference | `outcome_unknown` until the response is evidence | None |
| `submitting` (found by a restarted worker) | No recorded result for the in-flight attempt | `outcome_unknown`, then lookup | None |
| `reserved` | Provider evidence although submission never began | Unchanged; exception `evidence_before_submission` | None |
| Any nonterminal state | `rejected` without the explicit no-effect guarantee | Unchanged; exception | None |
| Any state | Evidence whose asset/amount/destination disagree with the transfer | Unchanged; exception `correlation_mismatch` | None |
| Any nonterminal state after submission began | Verified completion event or completed lookup | `settled` | Settle once |
| Any nonterminal state after submission began | Explicit final rejection guaranteeing no effect | `rejected` | Release once |
| `provider_pending` | Transient lookup failure | `provider_pending` | None; record failed observation |
| Terminal state | Duplicate or older evidence | Unchanged | None |

The worker must recover a persisted `submitting` operation after restart as potentially externally accepted. A webhook can overtake a submission response; a later response cannot regress `settled`. Contradictory terminal evidence creates an exception and preserves history. No compensating transfer is created automatically.

A missing lookup result is not, by itself, proof of final rejection. Keep uncertainty visible; retry lookup or submit the same provider reference under the simulator's idempotent contract. Never allocate a fresh reference to escape uncertainty. A timeout is never a reason to release a reservation.

## Minimal balanced journal

This is an educational signed-posting model, not a full accounting platform. Use accounts such as `user:A:available`, `user:A:reserved`, `provider:clearing` and `demo:funding`. Derive balances from immutable postings; any projection must be rebuildable and checked against the journal.

- Seed funds: +100000 available, -100000 demo funding.
- Reserve amount `a`: -a available, +a reserved.
- Settle: -a reserved, +a provider clearing.
- Reject: -a reserved, +a available.

Every posting batch sums to zero per asset. Protect phase uniqueness `(transfer_id, reserve|settle|release)` and forbid both settle and release for one transfer, using a transaction and locked/versioned transfer row. Lock a stable account row when checking and reserving funds so two distinct transfers cannot overspend concurrently. An idempotency retry must not repeat the balance check as if it were a new transfer.

Commit the transfer, reservation, idempotency result, trace event and job intent together. Commit terminal state, terminal journal effect and processing marker together. Keep `available` and `reserved` nonnegative; clearing and funding accounts have intentionally different semantics.

## Invariants to implement and expose

- **I1 Identity:** one accepted logical transfer per scoped idempotency key and payload; conflicting payloads cannot create another.
- **I2 Conservation:** every journal batch balances within `DEMO_USD` and projected totals agree with journal totals.
- **I3 Effects:** one reservation; at most one terminal effect; settlement and release mutually exclusive.
- **I4 Availability:** concurrent accepted transfers cannot overdraw available or reserved funds.
- **I5 State:** terminal states never regress; terminal state and corresponding journal postings agree.
- **I6 External identity:** all attempts for one transfer use the same provider reference; the simulator applies at most one effect per reference.
- **I7 Uncertainty:** timeouts never imply rejection or release; incomplete external evidence stays explicitly unresolved.
- **I8 Traceability:** accepted requests, attempts, observations and transitions have stable linked evidence IDs.

Application-side checks cannot prove an external effect count when the provider cannot be queried. Report `unknown`, not `pass`, for that part of I6; scenario tests may separately prove it with the simulator oracle. A valid `outcome_unknown` state is not itself an invariant violation.
