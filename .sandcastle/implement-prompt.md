/mattpocock-skills:implement {{ISSUE_URL}}

You are running AFK in a sandbox, on branch `{{BRANCH}}`, which is already checked out.
Nobody will answer a question, so do not ask one. Treat the issue, its comments and its
parent spec (if it has one) as settled. Read them with `gh issue view {{ISSUE_NUMBER}} --comments`.

Commit to `{{BRANCH}}`, and reference `#{{ISSUE_NUMBER}}` in each commit message. Do not
push, open a PR or close the issue. The runner does all three once you finish.

## This repository

- `README.md` says what the gateway is and how it is run; `CLAUDE.md` says how to build and
  test it, and `docs/agents/` covers the issue tracker, the triage labels and the domain docs.
- It is one npm package of ES modules (`src/*.mjs`), tested with `node --test`. Types are
  checked from JSDoc by `tsc`, so a new file needs `// @ts-check`-clean JSDoc, not a `.ts` file.
- `deploy/` is the bundle a box runs, and `deploy/*.test.mjs` guard it. A change to a
  script or template there needs its test updated with it.
- After you finish, the runner runs CI's `test` job itself and won't open a PR while it is
  red: `npm ci`, `npm test`, `npm run test:deploy` and `npm run typecheck`. Run them yourself
  before you commit. Never weaken, skip or ignore a test, and never loosen a lint or a
  type-check setting, to get green.
- The root `Dockerfile` and `publish-gateway-image.yml` are the published image. Don't change
  them unless the issue asks.
- A ticket that needs a live box or a credential no workflow exposes needs a human. Stop and
  say so, as below.

## When you cannot finish

Stop only when a genuinely new decision is needed and nothing in the repo or the parent spec
covers it, the action is irreversible, it touches real funds, or it needs a credential that no
workflow exposes. In that case, commit nothing and explain what blocks you in a comment on the
issue (`gh issue comment {{ISSUE_NUMBER}}`). The runner moves an issue with no commits to
`needs-triage`.

If your context is getting full (around 150k tokens) before you are done, commit what works,
write the remaining steps to `.sandcastle/logs/handoff-{{ISSUE_NUMBER}}.md`, commit it with
`git add -f`, and end your turn. A fresh session continues from your commits.

When the ticket is done and committed, output <promise>COMPLETE</promise>.
