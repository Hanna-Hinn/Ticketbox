# TB-NNN — Title of the task

**Status:** Draft | **Awaiting approval** | Approved | Superseded
**Date:**
**Task:** TB-NNN (`docs/02-product-delivery-plan.md`)
**Branch:** `feat/TB-NNN-short-slug`
**Approved by:** _(leave blank until a human writes their name here)_
**Approved on:**

> **Nothing in this plan gets implemented until Status reads Approved.**
> Phase 1 of the workflow ends at approval, not at "the plan looks finished".

---

## 1. The task, verbatim from the delivery plan

Copy these three lines exactly as written. They are the contract; paraphrasing them
is how scope drifts.

**Scope:**

**Acceptance:**

**Tests:**

**Depends on:** TB-NNN, TB-NNN — confirmed merged: ☐

---

## 2. What I understand this to mean

Two or three sentences in your own words. If your restatement and the Scope line
disagree, stop and resolve that before going further — that disagreement is the
whole reason this section exists.

---

## 3. Approach

How you intend to build it. Enough that a reviewer can disagree with the *approach*
before any code exists, which is the cheapest possible moment to disagree.

### Layers touched

| Layer | What changes |
| --- | --- |
| L1 `domain/**` | |
| L2 `application/**` | |
| L3 `infrastructure/**`, `presentation/**` | |
| L4 `main/**`, `worker/**` | |

### New or changed ports

Name, signature, and the fake that will back the unit tests. If this task adds no
port, say so — "none" is a real answer.

```ts

```

### Redis keys

New or changed keys, and where they go in `infrastructure/redis/keys.ts`.
State which carry a TTL. A key added here is a key that has to be renamed later at
the cost of orphaning live data, so get the shape right now.

### Lua scripts

For each: the file, KEYS, ARGV, the return contract, and **the race the atomicity
prevents**. That last one is the header comment the script will ship with.

### Migrations

New numbered file(s). Never an edit to one that has already run.

---

## 4. Files

| File | New / Changed | Why |
| --- | --- | --- |
| | | |

Anything not in this table is out of scope for the PR. If implementation turns out
to need a file that isn't listed, that's a plan change — say so rather than quietly
widening the diff.

---

## 5. Test plan

Match the levels the delivery plan's **Tests** line demands. Name the specific
behaviours, not the count.

| Level | Test | What it would catch |
| --- | --- | --- |
| Unit | | |
| Integration | | |
| Concurrency | | |
| Smoke | | |
| E2E | | |

**Concurrency:** does this task touch inventory? If yes, name the exact assertion —
N simultaneous operations against a known capacity, exact final count expected.
If no, say why not.

**How each test will be proven able to fail:** what you will break, deliberately, to
watch it go red.

---

## 6. Risks and failure modes

Answer all four. "Not applicable" is acceptable; silence is not.

- **What if Redis is down?**
- **What if a key is evicted under `allkeys-lru`?**
- **What if this operation runs twice?**
- **What if it dies halfway through?**

---

## 7. Could Postgres already do this?

Required whenever this task adds a Redis capability. State the Postgres answer
honestly, then say why Redis is being used anyway. "Because learning Redis is the
point of this project" is a valid and honest reason. An invented scalability
argument is not.

---

## 8. Open questions

Anything that needs a human decision before coding starts. **A plan with unresolved
blocking questions must not be approved.**

1.

---

## 9. Documentation this task will produce

- ☐ ADR — `docs/adr/NNNN-title.md` — needed? If a real decision was made, yes
- ☐ Task doc — `docs/tasks/TB-NNN-short-slug.md` — always
- ☐ Benchmark entry — `docs/BENCHMARKS.md` — needed if anything measurable changed
- ☐ NOTES entry — `docs/NOTES.md` — only for SPIKE tasks
