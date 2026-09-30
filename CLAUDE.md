# CLAUDE.md

The Workload Gateway: a stable HTTPS name for a TOON Network workload, keyed by its workload id.
`README.md` says what it is and how to run one; `deploy/README.md` covers the box bundle. Issue
tracker, triage labels and domain docs are in `docs/agents/`.

## Commands

```bash
npm ci                  # install (the lockfile is under test)
npm test                # node --test "tests/**/*.test.mjs"
npm run test:deploy     # node --test "deploy/*.test.mjs": the deploy bundle's guards
npm run typecheck       # tsc over the JSDoc in src/ and tests/
```

That is the `test` job in `.github/workflows/ci.yml`, in that order, and it is the gate the AFK
runner (`.sandcastle/`, `agent-implement.yml`) runs before it opens a PR. The `docker-build` job
builds the root `Dockerfile`, the published image; the sandbox image is the shared
`ghcr.io/toon-protocol/sandcastle-agent` (built from connector) and is a different thing.

Never weaken, skip or ignore a test, and never loosen a type-check or lint setting, to get green.
