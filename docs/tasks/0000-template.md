# TB-NNN — Title of the task

**Status:** Merged | Reverted
**Date completed:**
**Task:** TB-NNN (`docs/02-product-delivery-plan.md`)
**Plan:** [`docs/implementation-plans/TB-NNN-short-slug.md`](../implementation-plans/)
**Branch / PR:** `feat/TB-NNN-short-slug` · #NN
**ADR:** [`docs/adr/NNNN-title.md`](../adr/) — or "none, no decision needed"

> Written **after** the work is done, from what actually happened — not from the plan.
> Where they differ, section 3 is the most valuable part of this document.

---

## What this task delivered

Two or three sentences. What can the system do now that it couldn't before?

---

## How it works

The mechanism, not a restatement of the diff. Enough that you can reconstruct the
reasoning in six months without reading the code first.

```
<a short trace, a key layout, or a sequence — whatever makes the mechanism visible>
```

### Layers touched

| Layer | What changed |
| --- | --- |
| L1 `domain/**` | |
| L2 `application/**` | |
| L3 `infrastructure/**`, `presentation/**` | |
| L4 `main/**`, `worker/**` | |

### Key files

| File | What it does |
| --- | --- |
| | |

### Redis keys introduced

| Key | Type | TTL | Who writes it | Who reads it |
| --- | --- | --- | --- | --- |
| | | | | |

### Lua scripts introduced

| Script | The race it prevents |
| --- | --- |
| | |

---

## 3. Where this diverged from the plan

**The most useful section in this file.** What did you discover during
implementation that the plan got wrong, missed, or oversimplified?

If nothing diverged, write "nothing" — but be honest about it. A plan that survived
contact with the code completely intact is unusual enough to be worth noting.

| Planned | What actually happened | Why |
| --- | --- | --- |
| | | |

---

## 4. Tests shipped

| Level | Test file | Behaviour asserted |
| --- | --- | --- |
| Unit | | |
| Integration | | |
| Concurrency | | |
| Smoke | | |
| E2E | | |

**Proven able to fail:** what was broken deliberately, and what went red.

```
<the failure output, so the proof is on record and not just claimed>
```

**Coverage after this task:** `domain/**` __% · `application/**` __% · `infrastructure/**` __%

---

## 5. Code review outcome

**Reviewer:** `engineering-code-reviewer`
**Verdict:** SAFE TO MERGE | NEEDS WORK → fixed → re-reviewed

| Finding | Severity | Resolution |
| --- | --- | --- |
| | | |

Findings deliberately **not** fixed, and why:

---

## 6. Failure modes, as built

Not as planned — as the code actually behaves. If you tested any of these, say so.

- **Redis down:**
- **Key evicted under `allkeys-lru`:**
- **Operation runs twice:**
- **Dies halfway through:**

---

## 7. What I'd do differently

One or two honest sentences. This is the field you'll actually want later.

---

## 8. Follow-ups left behind

Anything knowingly deferred. Every `// TODO(tech-debt):` added by this task belongs
here with the reason it was acceptable to defer.

- [ ]
