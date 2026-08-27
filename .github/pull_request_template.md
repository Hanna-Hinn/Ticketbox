<!--
One task = one branch = one PR = one squash merge (CLAUDE.md).
If this PR is repo tooling / docs infrastructure rather than a TB-NNN task from
docs/02-product-delivery-plan.md, say so under What/Why and delete the phase
checklist below — it doesn't apply.
-->

## What

<!-- One or two sentences. What does this PR actually change? -->

## Why

<!-- The Why line from the task in docs/02-product-delivery-plan.md, or your own
     reason if this isn't a TB-NNN task. -->

## Task ID

Closes: TB-NNN

## Workflow phases

<!-- CLAUDE.md: "A PR without an approved plan, a clean code review, and a task
     doc is not ready, whatever CI says." Check off only what's actually true. -->

- [ ] **Plan approved** — [`docs/implementation-plans/TB-NNN-slug.md`](docs/implementation-plans/)
- [ ] **Code review clean** — `engineering-code-reviewer` verdict: SAFE TO MERGE (fix → re-review if it wasn't on the first pass)
- [ ] **Tests** — every level `docs/02-product-delivery-plan.md`'s Tests line names for this task, each one proven able to fail before being trusted
- [ ] **Task doc** — [`docs/tasks/TB-NNN-slug.md`](docs/tasks/), including an honest "where this diverged from the plan"

## Tests

<!-- Paste real commands and real output. "Tests pass" with nothing pasted
     under it isn't evidence — CLAUDE.md is explicit about this. -->

```

```

## Reviewer notes

<!-- Anything worth a reviewer's specific attention: a judgment call flagged
     during planning, a real bug found during implementation, a deliberate
     scope decision, something that diverged from the plan and why. Skip this
     section if there's genuinely nothing here — don't pad it. -->
