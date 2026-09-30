# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase. This repo is **single-context**: one npm package, the Workload Gateway.

## Before exploring, read these

- **`CLAUDE.md`** at the repo root: how to build and test.
- **`README.md`**: what the gateway is, and the operator's guide to running one.
- **`deploy/README.md`**: the bundle a box runs, in detail.

This repo has no `CONTEXT.md`, no `docs/adr/` and no `CONTEXT-MAP.md`. The decisions that bind the
gateway, and the spec it implements, live in
[`toon-protocol/TOON_Network`](https://github.com/toon-protocol/TOON_Network) (`CONTEXT.md` is its
glossary, `docs/adr/` its decisions, `docs/spec/` the spec). Payment, claims and settlement are the
connector's, in [`toon-protocol/connector`](https://github.com/toon-protocol/connector) (its
`CONTEXT.md` and `docs/adr/`). When a ticket cites an ADR or a spec section by number, read it
there.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest
creating them upfront. The `/domain-modeling` skill creates them lazily when terms or decisions
actually get resolved.

## Use the vocabulary the docs use

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a
test name), use the term as `README.md` and the TOON_Network glossary define it: **workload id**,
**Gateway Grant**, **Hidden Provider**, **Takeover**. Don't drift to synonyms they avoid. The
gateway is an **app** behind a connector route, not a connector.

## Flag ADR conflicts

If your output contradicts an ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0013 (hostnames and TLS live in a Workload Gateway) — but worth reopening because…_
