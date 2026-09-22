# Why a first-party client, not just a documented API

This describes the business reasoning behind shipping a Node/TypeScript
client (`sdk/node`) alongside the REST API, rather than treating
accurate API documentation as sufficient on its own. For the actual
mechanism, see [`../../technical/sdk/`](../../technical/sdk/); for how
to use it, see [`../../guide/sdk/`](../../guide/sdk/); for the
architectural decision record, see
[`../../adr/0005-first-party-node-sdk.md`](../../adr/0005-first-party-node-sdk.md).

## Documentation doesn't stop a real integration from getting three things wrong

A payment gateway's request-signing and idempotency conventions exist
for real reasons — they're not paperwork. But *knowing* the rules and
*implementing them correctly under a deadline, by hand, once* are
different things, and the gap between them has real business
consequences, not just correctness ones:

- **A merchant that signs requests incorrectly doesn't fail loudly and
  once — it fails confusingly, on some requests and not others**,
  because a body-re-serialization bug in a hand-rolled signer often
  only manifests for certain payload shapes (a nested object, a number
  that formats differently). The realistic failure mode for a team
  under pressure to ship isn't "we noticed and fixed our signing code"
  — it's "we couldn't figure out why some requests get 401'd, so we
  built a workaround," and a workaround for a security control is worse
  than the original bug.
- **A merchant that mismanages idempotency keys under retry either
  double-charges a real customer or drops a charge that should have
  gone through.** Both are real-money incidents that show up as support
  tickets and chargebacks, not engineering bugs someone quietly fixes —
  and by the time it's visible, real customer trust and real
  reconciliation effort are already spent.
- **A merchant that skips webhook signature verification entirely
  has a receiver that will act on a forged event exactly as if it were
  real** — a fabricated `dispute.created` or `subscription.canceled`
  notification, sent by anyone who knows (or guesses) the receiving
  URL, with no cryptographic check standing between a spoofed request
  and a real state change on the merchant's side.

None of these are hypothetical edge cases specific to careless
integrators — they're the natural failure modes of "implement a
security-relevant protocol correctly, once, under time pressure,
without a second reviewer." A first-party client's job is to make
implementing it *incorrectly* the harder path, not the easier one.

## What this changes, and what it deliberately doesn't

The client doesn't relax or bypass anything this platform enforces —
`HmacSignatureGuard`, the idempotency lock, and outbound-webhook signing
all still work exactly as documented in
[`../compliance-and-security.md`](../compliance-and-security.md) and
[`../../technical/security-and-compliance.md`](../../technical/security-and-compliance.md).
What changes is *who* has to get the mechanics right: with the client,
it's this platform's own maintainers, once, verified against the real
running guards (see [`../../technical/sdk/`](../../technical/sdk/)'s
testing-strategy section) — not every downstream integration team,
independently, under whatever time pressure they happen to be under
when they build it.

**This is scoped honestly, not presented as full coverage.** The client
wraps the money-movement endpoints (charge, refund, capture, cancel,
fetch-by-id) and outbound webhook verification — the specific surface
where the three failure modes above actually live. It does not (yet)
wrap subscriptions, disputes, marketplace splits, agent delegations, or
any admin operation; those remain real API endpoints an integrator
calls directly, same as before this client existed. Claiming broader
coverage than that would create exactly the kind of false confidence
this document is arguing against.

## Why this matters for adoption, not just correctness

A client library is often the *actual* integration surface a developer
touches — more so than the raw API reference — because it's what shows
up in their editor's autocomplete and what a tutorial walks through
line by line. A platform whose only integration path is "read the REST
reference and implement HMAC signing yourself" is asking every
integrator to correctly re-implement the same security-relevant
plumbing independently; a first-party client closes that gap for
whichever share of integrations actually use it, and — being real,
tested code living in this repository rather than a hypothetical
future package — gives a concrete answer the next time the question
"do you have an SDK" comes up, instead of "not yet, but the API is well
documented."
