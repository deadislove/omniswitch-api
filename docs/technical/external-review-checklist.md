# External Review Checklist

This project's security/compliance posture is entirely self-assessed —
[`security-and-compliance.md`](./security-and-compliance.md),
[`compliance-certification-roadmap.md`](./compliance-certification-roadmap.md),
[`secret-management.md`](./secret-management.md), and
[`tests/threshold-calibration.md`](./tests/threshold-calibration.md) are
all written by the same person who wrote the code they describe. That's
disclosed honestly throughout, but disclosure isn't the same as
independent verification. This document doesn't provide that
verification — it exists to make getting it cheaper, by pointing a
second, qualified reviewer at the specific claims worth checking first,
instead of "please review everything." Every entry names the exact
claim, where its evidence lives, and what to check independently rather
than take on the original author's word.

A self-review can't catch its own blind spots by definition — that's
the actual reason this document exists, rather than a disclaimer to get past.

---

## Tier 1 — claims that, if wrong, invalidate something else in this repo

### Sanctions screening: is the OFAC SDN match logic actually sound?

- **Claim**: [`security-and-compliance.md#sanctionswatchlist-screening`](./security-and-compliance.md#sanctionswatchlist-screening)
  and `src/modules/merchant/ofac-sdn-sanctions.adapter.ts` — a real,
  self-hosted fuzzy match (Jaro-Winkler, default threshold 0.92) against
  the real OFAC SDN list rather than a stub.
- **Verify independently**: pull real, publicly known SDN entries and
  clearly-unsanctioned names with similar spelling (the exact
  false-positive/false-negative tradeoff a 0.92 threshold is making),
  and confirm the matcher's behavior on both sides. Check whether
  `ofac-sdn-sanctions.adapter.spec.ts`'s existing test cases are
  adversarial enough (near-miss spellings, transliteration variants) or
  only exact/obviously-different names.
- **Why this matters most**: this is the control that closes what would
  otherwise be a hard legal blocker the moment real cross-border money
  moves through this system. If the matching logic is weak, the
  feature's existence doesn't actually close that gap.

### PCI DSS scope claim: does card-token validation actually reject everything that looks like a raw PAN?

- **Claim**: [`README.md`](../../README.md)'s PCI DSS section —
  `cardToken`/`paymentMethodId` are validated to reject anything
  resembling a real card number, keeping this system in SAQ A/A-EP
  scope.
- **Verify independently**: find the actual validation logic and test
  it against real test card numbers from Stripe's and Adyen's own
  published test-card lists — confirm none of them would pass as a
  `cardToken`. The entire PCI-scope argument rests on this one check;
  it's worth running inputs through it rather than reading the docblock.

### Vault authentication: does `VaultTransitService`'s AppRole renewal actually work?

- **Status: fixed 2026-09-26** — `VaultTransitService` now supports
  `VAULT_AUTH_METHOD=approle` with a background renewal loop at 2/3 of
  the token's lease; the static-token default is unchanged. See
  [`secret-management.md`'s migration section](./secret-management.md#migration-path-for-k8s-level-secrets-and-production-vault)
  for the full writeup.
- **Verify independently**: run `scripts/vault/bootstrap-approle.sh`
  against a real dev-mode Vault, confirm login/encrypt/decrypt/renew-self
  all succeed with the resulting scoped token, and confirm the policy
  actually denies `/v1/sys/mounts`, reading `hmac-secrets` key metadata,
  and `encrypt`/`decrypt` against any other Transit key (all should
  403). This was verified once already while building the fix — an
  independent re-verification is still worth doing rather than trusting
  that pass.

---

## Tier 2 — worth spot-checking, lower blast radius if wrong

### Reconciliation: is per-payment exception isolation actually sound?

- **Status: fixed** — `ReconciliationService.reconcile()` (see
  [`reconciliation.md`](./reconciliation.md)) now catches a failure in
  one payment's comparison and records it as its own `COMPARISON_ERROR`
  mismatch, rather than letting it propagate and fail the whole hourly
  run for that provider. A currency mismatch specifically is also kept
  as its own `CURRENCY_MISMATCH` type, distinct from `AMOUNT_MISMATCH`,
  since it can be a legitimate PSP-side conversion rather than a bug.
- **Verify independently**: trigger a comparison exception for one
  payment in a batch (e.g. malformed settlement data) and confirm the
  other payments in the same run still get compared and reported
  correctly — don't just trust that the `try`/`catch` is positioned
  correctly by reading it; run it.

### SAST exception (`bearer.ignore`): is the SSRF false-positive reasoning actually sound?

- **Claim**: [`security-and-compliance.md#sast-findings-documented-reviewed-exceptions`](./security-and-compliance.md#sast-findings-documented-reviewed-exceptions)
  — the flagged URL in `sdk/go/http_sender.go` is caller-supplied client
  configuration, never attacker-reachable input.
- **Verify independently**: read `http_sender.go` directly and trace
  every call site — don't take the docblock's characterization as
  sufficient. Assuming "caller-supplied means safe" without tracing each
  actual caller is exactly the kind of reasoning that's easy to get
  wrong in one direction.

### Load-testing numbers: real methodology, or an easy-to-fake claim?

- **Claim**: [`tests/load-testing.md`](./tests/load-testing.md) — real
  numbers against a resource-capped production Docker image rather than
  synthetic.
- **Verify independently**: rerun `npm run load-test:charge` /
  `load-test:read` locally, confirm the numbers reproduce within a
  reasonable margin, and confirm the resource caps described are
  actually what the container runs under.

### Calibration methodology: are the synthetic-data assumptions reasonable, beyond just the arithmetic?

- **Claim**: [`tests/threshold-calibration.md`](./tests/threshold-calibration.md)
  — a real precision/recall/break-even calibration methodology, run
  against synthetic data with explicitly-stated illustrative
  assumptions (an 85/12/3 risk-tier mixture, per-reason-code contest win
  rates, an $8 assumed operational cost per dispute contest).
- **Verify independently**: the *math* is checkable by any engineer; the
  *assumptions* are a domain judgment call a reviewer with real payments
  experience should sanity-check. This document is explicit that these
  are unfitted placeholders, so the useful review question isn't "is
  this correct" but "is this a reasonable placeholder to reason from
  until real data exists."

### Contract tests: has anyone actually run them?

- **Claim**: [`tests/contract-testing.md`](./tests/contract-testing.md)
  — a real, executable test suite against Stripe/Adyen's real test-mode
  APIs exists (`test/contract/`), but its own status line says "never
  executed" — no sandbox credentials exist in this repo or its CI.
- **Verify independently**: this is the one item on this list an
  external reviewer can most directly and cheaply resolve — get a
  Stripe test-mode key, follow that document's instructions, and run it.
  A clean run converts this from "the adapter's code believes this is
  correct" to "confirmed against the real API on this date."

---

## Not worth an external reviewer's time

Anything already listed in [`README.md`](../../README.md)'s Known
Limitations, or `DEV_README.md`'s Tier 1–3 gaps — these are
self-identified, tracked, and already accurately described as open. An
independent reviewer's time is better spent stress-testing the claims
*presented as resolved* above than re-confirming gaps this project
already admits to.
