# Form 5 — AI Interaction Summary


## 1. Tool Manifest

| Model / Tool | Primary Purpose of Use | Effectiveness (1–5) & Brief Why |
|---|---|---|
| **Claude Opus 5** (via Claude Code CLI) | Architecture design, full implementation, test authoring, documentation | **4** — Strong on the structural decisions (chunked ingestion, epoch invalidation) and on articulating trade-offs. Lost a mark for producing two defects that looked correct and passed casual inspection; both were caught only by executing the code and reconciling numbers, not by reading it. See section 3. |
| **PostgreSQL 16 `EXPLAIN ANALYZE`** | Verifying query plans rather than trusting claimed performance | **5** — Turned "this join is cheap" into a measured plan showing a top-N heapsort over 62,400 rows. The figures in ADR.md come from here. |
| **Vitest against a live Postgres** | Verification harness | **5** — The two most important defects were surfaced by tests, not by review. |

---

## 2. AI Tool Usage Approach

| Phase / Task | Prompting Strategy & Context Provided | Human Refinement |
|---|---|---|
| **Framing** | Supplied the case PDF in full rather than a summary, so the constraints (serverless timeout, restricted memory, stateless, "new product must auto-benefit") stayed in context for every later decision. | Directed the stack and scope explicitly: Postgres + Prisma, a runnable docker-compose rather than a design sketch, and a portable pipeline core with thin platform adapters rather than committing the repo to Azure. |
| **Architecture** | Required that the naive solution be stated and rejected before the chosen one was designed, for both scenarios — so the reasoning was visible and reviewable rather than implicit. | Insisted the two scenarios be solved with their *opposing* pressures acknowledged: Scenario B's read-time resolution makes sorting more expensive, and that tension had to be argued rather than hidden. |
| **Schema** | Asked for the "at most one active promotion" rule to be enforced where it could not be raced, rather than in service code. | Required the concurrency claim to be proven by a test firing ten simultaneous writers, not asserted in prose. |
| **Scenario A** | Specified that each stage be independently killable and resumable, and that the trigger endpoint must not accept the upload. | Required the resumability claim to be demonstrated by `SIGKILL`ing the worker mid-run and showing convergence to the correct row count. |
| **Scenario B** | Required invalidation cost to be independent of catalogue size. | Pushed back on stale-read risk until the read-before-load epoch ordering was made explicit and the L1 staleness window was quantified as a configuration value rather than left as hidden behaviour. |
| **Verification** | Required every performance claim in the ADR to carry a measured number. | Rejected "it scales" style claims without figures; all numbers in ADR.md were produced by running the system. |

---

## 3. Judgement, Challenges & Verification

### Challenge 1 — A silently wrong `ORDER BY` (the most serious defect)

**Encountered.** The product list query casts money to text for exact transport:

```sql
SELECT effective_price::text AS effective_price, ... FROM priced
ORDER BY effective_price ASC
```

This looked obviously correct and passed review by eye.

**Verification.** A test sorted a set where base-price and effective-price
orderings *diverge* — a 300.00 product at 90% off against a 100.00 product at
full price. Expected `[30.00, 100.00]`; got `[100.00, 30.00]`.

**Root cause.** SQL resolves a bare column name in `ORDER BY` against **output
aliases before input columns**. The text cast shadows the numeric column, so
the sort was lexicographic: `'100.00'` sorts before `'30.00'` because `'1'` <
`'3'`.

**Resolution.** Qualify the reference — `ORDER BY priced.effective_price` —
which forces resolution to the numeric input column.

**Why this one matters.** The endpoint's headline feature is sorting by
effective price. The output was *ordered*, just wrongly, so every smoke test
passed and the bug was invisible to inspection. It would have reached
production as "cheapest first" returning the wrong products, and would only
have been noticed by a customer. **Any test whose fixtures had base price and
effective price in the same order would have missed it** — the test had to be
designed around the divergence specifically.

### Challenge 2 — Test data that avoided the bugs it existed to catch

**Encountered.** The 500,000-row generator deliberately emits three awkward
cases: duplicate SKUs, quoted fields containing newlines, and invalid rows. The
first run reported `rowsRejected: 0` and exactly `500,000` rows processed.

**Verification.** Those numbers were *too clean*. The counts should not have
been round, since rejections and de-duplication both reduce them. Rather than
accepting a passing result, I enumerated the generator's branch conditions
arithmetically.

**Root cause — two independent bugs.**

1. The branches used separate moduli (5,000 / 7,000 / 10,000) checked in order.
   **Every multiple of 10,000 is also a multiple of 5,000**, so the duplicate
   branch shadowed the invalid branch entirely: the invalid-row path was dead
   code and zero invalid rows were ever generated.
2. The duplicate interval (5,000) is a **multiple of the upsert batch size
   (500)**. A duplicate at index *i* and its original at *i−1* therefore
   straddled a batch boundary every single time, so the intra-batch
   de-duplication path never executed either.

**Resolution.** Select all three cases by distinct residues of a single modulus
— disjoint by construction — and choose residues that are not multiples of the
batch size.

**Why this one matters.** This is the more insidious failure. The pipeline
*appeared* fully exercised across 500,000 rows and 250 chunks, and reported
success. Two of its most delicate paths had never run. After the fix the
numbers reconcile exactly: 500,000 − 100 rejected − 100 collapsed = **499,800**,
matching the database row count. **A green test run is evidence only if you can
explain the numbers it produced.**

### Challenge 3 — Locale-dependent error matching

**Encountered.** Prisma does not map Postgres exclusion violations to a
dedicated error code, so the conflict-to-`409` translation inspects the driver
error. The natural implementation matches on message text.

**Verification.** The development machine emits Postgres errors in **Turkish**
(`HATA: çakışan anahtar değeri...`), which made the fragility immediate rather
than theoretical.

**Resolution.** Match on constraint *names* (`promotions_no_overlap_per_product`),
which are locale-invariant. Under English locale this would have shipped and
then failed in any differently-configured environment.

### Challenge 4 — Architectural pressure toward the wrong Scenario B design

**Encountered.** Denormalising `effective_price` onto the product row is the
conventional answer, it makes the sort trivial, and it is what most discussions
of this problem reach for first.

**Verification.** Checked it against all three stated requirements rather than
just the performance one. It fails the third outright: a product created
*during* a flash sale was never part of the batch update, so it never receives
the discount — and the case explicitly requires that it does.

**Resolution.** Resolve at read time and invalidate by epoch. The decisive
argument is an asymmetry worth stating explicitly: **there are millions of
products but only tens of active promotions**. Optimise around the small set,
never the large one. The cost — a sort over the filtered category, measured at
108 ms uncached — is documented rather than hidden, and paid once per epoch
rather than per request.

---

## 4. Overall Reflection

**Estimated ratio: ~70% AI-generated / ~30% human-directed.**  

> DISCLAIMER
> The more useful signal is not the split but the *shape* of the contribution:
> which specific decisions were steered, and which defects were caught and how.
> Sections 2 and 3 are the substantive answer; this number is a summary of where
> the keystrokes came from, not a measure of where the thinking came from.

The raw code, schema, tests and documentation were AI-generated. The human
contribution was concentrated in the decisions that determined whether that
output was worth anything: choice of stack and scope, the requirement that each
scenario's naive solution be explicitly rejected before the chosen one was
designed, the insistence that claims be measured rather than asserted, and the
refusal to accept a clean-looking test result whose numbers could not be
explained. On this task, the leverage was in verification and direction, not in
generating lines of code.

**Key takeaway — the blind spot the tools revealed.**

Both significant defects share a signature: **the code was wrong in a way that
still produced plausible output**. The `ORDER BY` bug returned a correctly
paginated, correctly formatted, correctly sorted-looking list. The generator
bug produced a green run across 500,000 rows and 250 chunks. Neither was
detectable by reading the code, and neither triggered an error.

Where AI assistance was weakest was not architecture — the structural decisions
were sound and the trade-off reasoning was genuinely useful — but in
**self-verification**. It generated tests that confirmed its own assumptions,
including test *data* that happened to avoid the edge cases the tests were
written for. The defects were found by executing the system and interrogating
the numbers, never by review. One of the important challenges that is not considered by AI generated architecture plan was
rate limiting. Since this endpoints needs to be protected against DDoS kind outages I've explicitly 
guide AI to use a basic rate limiter.


The practical adjustment this forced: treat AI-generated tests as part of the
artefact under test, not as evidence about it. The questions that actually
found bugs were **"why is this number exactly round?"** and **"construct the
case where the naive implementation and the correct one disagree"** — and both
are human questions that had to be asked deliberately.


