# Architecture Decision Records

An ADR records *why* a specific technical decision was made — the
alternatives considered, the trade-off accepted, and (where it applies)
the real bug that decision fixed. It's not a description of the current
system; that's what [`../technical/architecture.md`](../technical/architecture.md)
is for. An ADR is written once, at the time of the decision, and rarely
edited afterward — a decision that gets reversed gets a *new* ADR that
marks the old one `Superseded`, rather than rewriting history.

The point of keeping these is continuity: anyone picking this codebase
up later — including a future version of the person who wrote it —
shouldn't have to reverse-engineer *why* the ledger is written the way
it is from `git blame` and guesswork. That matters more than usual for
this project specifically, since it's an open-source reference
implementation explicitly meant to be legible and extensible by people
who weren't in the room for any of these decisions.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](./0001-hexagonal-architecture.md) | Hexagonal architecture (ports & adapters) for the payment module | Accepted |
| [0002](./0002-transactional-outbox-for-ledger-events.md) | Transactional outbox for ledger events instead of a dual write | Accepted |
| [0003](./0003-saga-orchestration-for-checkout.md) | Orchestrated saga with compensating actions for checkout | Accepted |
| [0004](./0004-smart-routing-with-circuit-breaker.md) | Smart PSP routing with a shared circuit breaker, not a static primary/fallback | Accepted |

## Format

Each ADR follows the same shape:

- **Status** — `Proposed` / `Accepted` / `Superseded by ADR-NNNN`
- **Context** — the problem, and the constraint that made it worth a
  written decision instead of an obvious default
- **Decision** — what was actually built
- **Consequences** — what this trades away, not just what it buys;
  including a real bug the current shape fixed, if there was one
- **Alternatives considered** — the options that lost, and why

## Adding a new one

Number sequentially (`000N-kebab-case-title.md`), add a row to the
index above, and link it from the relevant `technical/` or
`business-domain/` doc's "Where to look next" section. Write the
`Consequences` section honestly — what this decision makes harder, not
just what it makes possible — the same posture the rest of `docs/`
already takes.
