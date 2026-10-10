# Real Provider Credential Test Plan: Beyond PSP Contract Testing

[`contract-testing.md`](./contract-testing.md) already covers Stripe and
Adyen — a real, executable suite (`test/contract/`) against their real
test-mode APIs, gated behind credential env vars, never executed only
because no sandbox credentials exist in this repo or its CI. Read that
document and run it first; nothing below repeats it.

This document covers what contract testing doesn't: the three other
external integrations this codebase has real (not just mocked) adapters
for — KYC/KYB (Persona) and ACH/wire bank transfer — plus two things
`contract-testing.md` explicitly states are out of its own scope (real
webhook delivery, reconciliation against a real settlement report). One
of the findings below is a genuine code gap, beyond just a missing-
credentials problem — flagged in its own section rather than glossed
over.

---

## KYC/KYB (Persona) — blocked on a real code gap, beyond just config

`merchant.module.ts` already wires a config-driven switch
(`KYC_PROVIDER`/`KYB_PROVIDER`, `mock` default, `persona` the real
option) to `PersonaKycProviderAdapter`/`PersonaKybProviderAdapter`. But
neither adapter sends any authentication at all —
`persona-kyc-provider.adapter.ts` sets only
`{ 'Content-Type': 'application/json' }` on its request; there is no
`Authorization` header and no API-key configuration read anywhere in
either file. Persona's real API requires a bearer API key. As written
today, pointing `PERSONA_PROVIDER_URL` at Persona's real sandbox would
still fail immediately — the request itself is unauthenticated,
regardless of what it's aimed at.

**Before this can be tested with real credentials, this needs a small
code change**:
1. Add a `PERSONA_API_KEY` config read to both
   `PersonaKycProviderAdapter` and `PersonaKybProviderAdapter`, sent as
   `Authorization: Bearer ${apiKey}` on every request.
2. Only then: set `KYC_PROVIDER=persona`, `KYB_PROVIDER=persona`,
   `PERSONA_PROVIDER_URL` to Persona's real sandbox base URL, and
   `PERSONA_API_KEY` to a real sandbox key.
3. Run a real KYC application submission and confirm the real webhook
   callback (`POST /webhooks/kyc`) round-trips through
   `KycWebhookGuard`'s real signature verification; same for a KYB
   submission through `KybWebhookGuard`.

## ACH/wire bank transfer — same class of gap, one step harder

`ach-bank-transfer.adapter.ts` and `wire-bank-transfer.adapter.ts` each
only read `ACH_PROVIDER_URL`/`WIRE_PROVIDER_URL` — no API key or auth
header configuration exists in either file. A real transfer provider
(the inline comments elsewhere in this codebase reference Dwolla's real
webhook shape specifically) would reject unauthenticated requests the
same way Persona's real API would.

**Before this can be tested with real credentials**:
1. Add real auth support to both adapters. Dwolla specifically uses
   OAuth2 client-credentials — a token-fetch-and-cache step rather than a
   static bearer header, so this is a slightly larger change than the
   Persona case above.
2. Only then: point `ACH_PROVIDER_URL`/`WIRE_PROVIDER_URL` at Dwolla's
   real sandbox, with real client ID/secret configured.
3. Run a real payout batch (`POST /admin/marketplace/run-payouts`),
   then a real transfer initiation
   (`POST /admin/marketplace/payouts/:id/initiate-transfer`), and
   confirm the real settlement webhook round-trips through
   `BankTransferWebhookGuard`'s real signature verification.

## Beyond what `contract-testing.md` covers for Stripe/Adyen

Two gaps that document names explicitly as out of its own scope, worth
closing separately once its basic suite has been run at least once:

- **Real webhook delivery.** `test/webhooks.e2e-spec.ts` covers
  signature verification end-to-end against payloads this repo
  constructs itself; it's never received an actual webhook from
  Stripe's or Adyen's real servers, which needs a publicly reachable
  endpoint (an ngrok/Cloudflare Tunnel to a local instance, or a real
  deployed environment) — a real Stripe/Adyen Dashboard test webhook
  endpoint pointed at `POST /api/v1/webhooks/stripe` /
  `POST /api/v1/webhooks/adyen`.
- **Reconciliation against a real settlement report.** After a real
  contract-test charge (or a webhook-verified one above),
  `POST /admin/reconciliation/run` for the relevant provider should
  produce a `CLEAN` result against Stripe's/Adyen's real
  balance-transactions/settlement-report API — the first time this
  system's reconciliation logic has run against anything other than
  `mock-psp`'s in-memory settlement records.

## Recommended order

1. **Stripe contract tests** (`contract-testing.md`) — zero code changes
   needed, run first.
2. **Adyen contract tests** (`contract-testing.md`) — same shape,
   confirms `PSPAdapterPort` genuinely works across two real providers.
3. **Real webhook + reconciliation** for whichever PSP is easier to get
   a public endpoint for.
4. **Persona**, only after adding `PERSONA_API_KEY` auth support above —
   otherwise the first real request fails immediately and proves
   nothing.
5. **Dwolla (ACH/wire)**, last — needs the larger OAuth2 change, and is
   lowest in the dependency chain: payouts only matter once real
   charges/marketplace splits are already proven against real
   Stripe/Adyen.

## What this closes, and what it still won't

Completing everything above closes "no external integration has ever
been exercised against real provider behavior." It does not close: real
production transaction volume (still needed for
[`threshold-calibration.md`](./threshold-calibration.md)'s work), a real
compliance attestation
([`compliance-certification-roadmap.md`](../compliance-certification-roadmap.md)),
or multi-region disaster recovery (needs a real second cloud region,
unrelated to any provider credential). Keep this plan scoped to exactly
what it's for.
