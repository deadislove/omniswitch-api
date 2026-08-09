# Security Policy

## What this project is — and isn't

OmniSwitch is a **reference architecture / proof-of-concept**, built to
demonstrate how a payment gateway can be designed correctly (Hexagonal
Architecture + DDD, real double-entry ledger, real end-to-end testing
against real infrastructure). It is **not** a production payment system,
has never processed real money, and is explicitly not licensed for use
as one — see [`LICENSE`](./LICENSE).

That said, security issues in this codebase are still worth reporting
and fixing — the whole point of this project is to model good practice
honestly, including being honest about where it falls short. See
[`docs/technical/security-and-compliance.md`](./docs/technical/security-and-compliance.md)
for a detailed, self-reported account of this project's own security
design (JWT revocation, secret management via Vault) and known gaps
(PCI DSS scope, dev-mode Vault, plaintext K8s secrets), and the
top-level [`README.md`](./README.md#known-limitations) for the full,
current list of known limitations.

## Reporting a vulnerability

If you find a security issue in this codebase — something not already
covered in the documents above — please report it privately rather than
opening a public issue:

**Email**: daweilin7689@gmail.com

Please include:
- A description of the issue and its potential impact.
- Steps to reproduce it (a minimal example against the local
  `docker-compose.yml` setup is ideal, since this project has no
  hosted/production deployment).
- Any suggested fix, if you have one — not required.

You should expect an initial response within a few days. This is a
personal project maintained outside of full-time work, so response and
fix timelines are best-effort, not SLA-backed.

## Supported versions

This project doesn't maintain multiple release branches — only the
`main` branch is supported. There are no version tags to select a
"supported version" from; a report against any commit is welcome.

## Scope

In scope:
- The application code in `src/`, `test/`, and `scripts/mock-psp/`.
- The Docker/Kubernetes configuration (`docker-compose.yml`, `k8s/`) as
  it applies to *this project's own* deployment shape.

Out of scope (already known, already documented, no need to report):
- Anything already listed in
  [`README.md`'s Known Limitations](./README.md#known-limitations) or
  [`DEV_README.md`](./DEV_README.md) — these are deliberate, tracked
  gaps (e.g. Vault running in dev-mode, plaintext K8s secrets), not
  undiscovered vulnerabilities.
- The mock PSP server (`scripts/mock-psp/server.js`) is a local test
  double simulating Stripe/Adyen's API shapes — it is not a real
  payment processor and issues in its mock logic aren't a security
  concern in the way a real PSP integration's would be.
- Third-party dependencies — please report those upstream, though a
  heads-up here is still appreciated so this project can update.
