# Architecture Decision Record — ModaCo Promotion Management API

This document explains the architecture, defends the choices, and states what
each one costs. Scenarios A and B are covered in ADR-006 through ADR-010.

All performance figures are measured on the stack in this repository against a
**499,800-product catalogue**, on an Apple M-series laptop with Postgres 16 and
Redis running locally. They are included because a claim like "caching helps"
is worthless without a number attached; they are *not* production benchmarks,
and network latency, shared hardware and a cold buffer cache would all move
them. The shape of the results is the point, not the absolute values.

---

## Context

ModaCo needs an internal API over a product catalogue and a promotion system.
Two operational realities dominate the design, and they pull in opposite
directions:

- **Scenario A** — weekly 500,000-row vendor files, processed on a serverless
  consumption plan with a hard timeout, restricted memory, and no state between
  invocations. This is a *write* problem with an extreme burst profile.
- **Scenario B** — flash sales that reprice 50,000+ products instantly, while
  the storefront is under peak read load, and where products created *during* a
  sale must benefit from it automatically. This is a *read* problem where the
  obvious write-side solution is the trap.

A third requirement quietly constrains both: the product list must be
**sortable by effective price with pagination**. That single requirement is
what makes this more than a caching exercise, and it is discussed in ADR-007.

---

## Decisions at a glance

| # | Decision | Principal trade-off accepted |
|---|---|---|
| 1 | PostgreSQL as the datastore | Ties the design to Postgres-specific features |
| 2 | Prisma for schema/writes, hand-written SQL for hot reads | Two data-access idioms in one codebase |
| 3 | "One active promotion" enforced by `EXCLUDE` constraints | Errors surface as constraint violations needing translation |
| 4 | Cross-scope overlap resolved by specificity, not rejected | Merchandisers cannot see the winner without querying |
| 5 | Money as integer cents, duplicated in SQL and TypeScript | Two implementations to keep in lockstep |
| 6 | Effective price resolved at **read** time | Sorting by it costs a sort over the filtered set |
| 7 | Offset pagination, capped at 100 | Deep pages degrade; keyset deferred |
| 8 | Epoch-based cache invalidation | Global epoch over-invalidates on single-product promotions |
| 9 | Split-and-fan-out ingestion with durable chunk state | More moving parts than a single long-running job |
| 10 | Portable pipeline core with thin platform adapters | An indirection layer that a cloud-native version would not need |
| 11 | Bound every caller-controlled cost; ration per route class | Limiter fails open, and keys on IP until auth exists |
| 12 | Pricing is two invariants, shared by both write paths | Less expressive than real merchandising will eventually need |

---

## ADR-001 — PostgreSQL

**Decision.** Postgres 16.

**Why.** Three features carry real architectural weight here, and losing any of
them would mean writing application code to compensate:

- **GiST `EXCLUDE` constraints** make "at most one active promotion" a database
  invariant rather than a hopeful application check (ADR-003).
- **Partial indexes** keep the promotion lookup indexes scoped to
  `status = 'ACTIVE'`, so they stay small as cancelled promotions accumulate.
- **`NUMERIC`** gives exact decimal arithmetic. Money in a binary float is a
  defect that compounds across 500,000 rows.

**Trade-off.** The schema is not portable to MySQL without losing the
concurrency guarantee in ADR-003. That is accepted deliberately: the guarantee
is worth more than the portability, which nobody has asked for.

---

## ADR-002 — Prisma for the schema and writes, raw SQL for the hot reads

**Decision.** Prisma owns migrations, the generated types, and all writes. Two
read paths — the product list and product detail — are hand-written SQL in
`src/modules/products/product.repository.ts`.

**Why.** The list endpoint must `ORDER BY` a value that is not a column: the
effective price, which depends on whichever promotion wins for each row. No ORM
expresses "sort by a computed expression over a conditional join" without
materialising the result set in the application, which defeats pagination — the
database would return every matching product so the application could sort and
discard all but twenty of them.

The rest of the application gets nothing from raw SQL, so it does not use it.

**Trade-off.** Two idioms in one codebase, and the raw queries are not covered
by Prisma's type generation. Mitigated by confining raw SQL to one file with an
explicit row interface, and by testing those queries against a real database.

---

## ADR-003 — The business rule lives in the schema

**Decision.** "A product can have at most one active promotion at a time" is
enforced by two GiST `EXCLUDE` constraints, not by service-layer checks.

```sql
ALTER TABLE promotions
  ADD CONSTRAINT promotions_no_overlap_per_product
  EXCLUDE USING gist (
    product_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status = 'ACTIVE' AND scope = 'PRODUCT');
```

**Why.** The application-level version of this rule is a `SELECT` for conflicts
followed by an `INSERT`. That is a check-then-act race: two concurrent requests
both read "no conflict" and both insert, and the invariant is broken with no
error raised anywhere. It is not a narrow window either — it widens with every
API replica added.

`tests/promotions.test.ts` fires ten concurrent creates for the same category
and window and asserts that **exactly one** succeeds. It passes because the
database arbitrates, and it would fail against a service-layer check.

There is a second, less obvious payoff. The list query LEFT JOINs products to
active product-scope and category-scope promotions. Those joins are only
provably 1:1 *because* the constraints forbid two active same-scope promotions
on one target. Without them the joins could fan out, silently duplicating
products across pages and corrupting pagination. **The constraint is not just
enforcing a business rule — it is what makes the read query correct.**

**Trade-off.** Violations arrive as SQLSTATE `23P01` rather than as domain
errors, so `promotion.service.ts` translates them into a `409`. A friendly
pre-check runs first purely for the error message; it is explicitly advisory
and the constraint remains the authority. Matching is on constraint *names*,
not message text — the development machine emits Postgres errors in Turkish,
which is exactly how message-matching becomes a latent production bug.

---

## ADR-004 — Cross-scope overlap is precedence, not conflict

**Decision.** Two promotions of the *same* scope may not overlap in time.
A `PRODUCT`-scope and a `CATEGORY`-scope promotion covering the same product
**may** overlap, and the product-scope one wins.

**Why.** "20% off this jacket" and "50% off all accessories" are both
legitimate, are authored by different teams, and will coexist constantly.
Rejecting that would make the category promotion unusable the moment any
product in it had its own deal. Same-scope collisions are different: there is
no principled way to choose between two competing category sales, so the system
refuses the second.

Specificity ranking is data, not branching
(`SCOPE_PRECEDENCE` in `src/domain/promotion-resolution.ts`), so a future
brand-level or customer-segment scope is a one-line change plus a migration.

**Trade-off.** A merchandiser creating a category sale cannot tell from the
promotion record alone which products it will actually affect, because
product-scope promotions silently outrank it. A "preview affected products"
endpoint would close that gap; the `?at=` simulation parameter on the list
endpoint is a partial answer already.

---

## ADR-005 — Money as integer cents

**Decision.** `NUMERIC(12,2)` in Postgres; integer cents in TypeScript. Values
cross the boundary as strings, never as JavaScript floats.

**Why.** `0.1 + 0.2 !== 0.3`. Applying percentage discounts to 500,000 rows
makes that systematic rather than theoretical.

The awkward part is that effective price is computed **twice** — in SQL for the
sortable list, in TypeScript for detail and ingestion. If they ever disagreed
by one cent, the listing and the product page would show different prices for
the same item. `tests/pricing.test.ts` verifies **88 base/discount combinations
against the live database**, comparing the SQL result to the TypeScript result
byte for byte — including the one-cent floor, which both sides must apply
identically. The equivalence is argued in a comment and then checked rather than
assumed.

**Trade-off.** Duplicated logic, which is a genuine liability. The alternative —
computing prices only in the application — would make sorting by effective price
impossible without fetching the entire catalogue. The duplication is the lesser
cost, and the parity test is what keeps it honest.

---

## ADR-006 — Scenario B: resolve effective price at read time

**Decision.** Effective price is **never stored**. It is computed per query by
joining products to the small set of currently-active promotions.

### The alternative, and why it fails

The instinctive design is to denormalise: add `products.effective_price` and
update it whenever a promotion changes. It is tempting because it makes the
sort trivial. It fails on three counts, and the third is fatal:

1. **Write amplification at the worst moment.** "50% off all accessories"
   becomes a 62,400-row `UPDATE` — measured on this dataset — fired exactly
   when read traffic peaks. The flash sale creates its own contention.
2. **A correctness window.** While that update runs, some products show the
   sale price and others do not. There is no instant at which the catalogue is
   consistent.
3. **It cannot satisfy the requirement.** A product created *during* the flash
   sale was never part of the batch update, so it does not get the discount.
   Fixing that means a trigger or a hook on every product insert — and the
   ingestion pipeline inserts 500,000 of them.

Requirement 3 is decisive: the denormalised design cannot express "a new
product in this category benefits automatically" without bolting the read-time
resolution back on anyway.

### Why read-time resolution is affordable

The asymmetry that makes this work: **there are millions of products but only
tens of active promotions**. Joining a huge relation to a tiny one is cheap;
maintaining a value on every row of the huge relation is not. The query
evaluates the active set once in a CTE and hash-joins against it, rather than
running a correlated lookup per product row.

Measured on 499,800 products with a flash sale active:

| Operation | Result |
|---|---|
| Create category flash sale (62,500 products affected) | **11.5 ms**, **1 row written** |
| Product rows updated by that flash sale | **0** |
| New product in the category gets the discount | Automatically, no backfill |

**Caching simulations.** The `?at=` parameter originally bypassed the cache, on
the reasoning that point-in-time simulations are rare and would pollute it for
live traffic. That was true of the cache and false of the system — see ADR-013.
Simulated instants are now snapped to the minute and cached like any other page,
which collapses the key space enough for caching to work while keeping enough
precision that a sale starting at 14:30 is still visible to someone probing
14:31. Live reads are deliberately *not* snapped: they must reflect a promotion
that started seconds ago.

**Trade-off — and this is the real cost.** Sorting by effective price means
computing it for every candidate row before sorting. `EXPLAIN ANALYZE` on a
62,400-product category shows a **top-N heapsort over 62,400 rows** — the
planner cannot use an index for an expression spanning a conditional join.
Uncached, that is **~108 ms** end-to-end. ADR-008 is how that cost is paid
once rather than per request.

If the catalogue grew such that a single category held millions of products,
this would stop being affordable and the answer would change — most likely to a
materialised view refreshed on epoch change, accepting bounded staleness in
exchange for an indexable sort key. At ModaCo's stated scale it is not needed,
and adding it now would buy latency with correctness and complexity.

---

## ADR-007 — Offset pagination, capped

**Decision.** `page`/`limit` offset pagination, `limit` capped at 100.
`ORDER BY <sort>, id` always includes `id` as a tiebreaker.

**Why.** The brief asks for conventional pagination. The `id` tiebreaker is not
cosmetic: without a total ordering, rows sharing an effective price can appear
on two pages or none as the planner reshuffles equal keys between queries.

**A bug worth recording.** The outer query casts money columns to text for
exact transport (`effective_price::text AS effective_price`). SQL resolves a
bare column name in `ORDER BY` against **output aliases before input columns**,
so `ORDER BY effective_price` sorted the *text* column — lexicographically,
placing `'100.00'` before `'30.00'`. The output was ordered, just wrongly, and
looked entirely plausible. It was caught only by a test that sorts a set where
base-price and effective-price orderings diverge. The fix is to qualify the
reference (`ORDER BY priced.effective_price`), which forces resolution to the
numeric input column.

**Trade-off.** Deep offsets degrade — `OFFSET 10000` still sorts everything
before it. Keyset pagination is the successor, and the `(sort_key, id)` total
ordering already in place is exactly what it needs. It was not built because
real storefront traffic concentrates overwhelmingly on the first few pages.

**Security addendum.** Leaving `page` unbounded while capping `limit` was a
mistake: it made `OFFSET` attacker-controlled, and combined with the uncacheable
`?at=` path below it produced an unauthenticated request costing ~380 ms of
database work each time. The bound is now on the computed offset
`(page - 1) * limit` rather than on `page`, because `page=1000&limit=100` is a
hundred times more expensive than `page=1000&limit=1` and a cap on `page` alone
would have missed exactly the cases that hurt. See ADR-013.

---

## ADR-008 — Scenario B: epoch-based cache invalidation

**Decision.** Every cache entry is stamped with the value of a single global
counter. A read compares the stamp to the live counter and treats any mismatch
as a miss. Any promotion mutation does one `INCR`.

```
flash sale created ──▶ INCR modaco:promo:epoch ──▶ every derived entry
                       (one Redis op)               is now logically stale
```

**Why.** Targeted invalidation cannot work here. Deleting the cache entries for
50,000 affected products is the same write storm moved into Redis — and it is
not even possible for list pages, because which page contained which product is
only knowable by running the query. Epoch stamping makes invalidation **O(1)
and independent of catalogue size**, which is the property that makes flash
sales survivable.

Stale entries are never deleted. They stop matching and expire on their
existing TTL.

**One ordering detail that is a correctness bug if reversed.** The epoch is read
*before* the loader runs, and that pre-read value is what gets stamped. Reading
it afterwards would mean a promotion committing mid-load stamps a post-bump
epoch onto pre-bump data — marking stale prices as fresh for a full TTL. Taking
the earlier value means such an entry simply fails its next validation: the
cache errs toward extra misses, never toward stale reads. Likewise the epoch is
bumped **after** the transaction commits, so a concurrent reader cannot
repopulate from pre-commit state and stamp it as current.

Measured, on the 62,400-product category:

| Path | Latency | Cache tier |
|---|---|---|
| Product list, cold | 108 ms | miss |
| Product list, warm | **~2 ms** | Redis (L2) |
| Product detail, cold | 3.2 ms | miss |
| Product detail, warm | **~1.5 ms** | in-process (L1) |

**Trade-off — stated plainly.** The epoch is **global**, so a promotion on one
product invalidates cached entries for the whole catalogue. This is deliberate:
flash sales are the load event worth optimising for, single-product promotions
are comparatively rare, and per-category epochs cannot correctly invalidate
list pages that span categories. The cost is a brief drop in hit rate after any
promotion write. If single-product promotions became frequent, the refinement
would be a per-product epoch for detail entries alongside the global one for
lists.

---

## ADR-009 — Two cache tiers, and the staleness that buys

**Decision.** L1 is a bounded in-process `Map` with a 1-second TTL, used only
for product detail. L2 is Redis, shared across replicas and epoch-validated.

**Why.** The brief names product detail as the most highly trafficked endpoint.
L1 answers it with no network hop at all. The list endpoint is heavier per miss
but far lower in cardinality — page 1 of a category is requested vastly more
often than page 40 — so it uses Redis only; replicating list payloads into
every replica's heap would cost memory for little hit-rate gain.

**Trade-off, quantified.** An L1 hit does not consult Redis, so it cannot see
an epoch bump. `CACHE_L1_TTL_MS` is therefore *exactly* the worst-case window
in which a replica can serve a pre-flash-sale price: **1 second** by default,
and settable to `0` to disable the tier. That is a real consistency concession
and it is a configuration knob rather than a hidden behaviour.

The cache is never a correctness dependency. Redis failures fall through to
Postgres — `enableOfflineQueue: false` makes commands reject immediately rather
than block — and `/health` reports Redis down without reporting the service
unhealthy. A Redis outage during a flash sale costs latency, not availability.

Cache stampedes are handled by per-process single-flight: concurrent misses on
one key run the loader once. This bounds the worst case to one query per
replica rather than one per request.

**One Redis serves both the cache and the BullMQ queue, and that forces a
choice.** `maxmemory-policy` is server-wide, so a single policy has to cover two
workloads with opposite requirements. `allkeys-lru` is correct for a cache and
actively dangerous for a queue: under memory pressure Redis would evict queue
keys, and a chunk job that disappears is data loss — the pipeline's idempotency
protects against a chunk being *delivered twice*, not against one vanishing.
BullMQ warns about exactly this on every worker start, which is how the
misconfiguration surfaced once the stack ran in containers.

The resolution is `noeviction` with `maxmemory` set below the container limit.
Losing a cached price costs one Postgres round trip and the cache already falls
through on failure; losing a queued chunk costs correctness. A full Redis now
fails writes loudly rather than discarding jobs quietly, and cache growth stays
bounded by the short TTLs the application already sets. The cleaner production
arrangement is two instances — an LRU cache and a `noeviction` queue — which
also lets them be sized and monitored independently; it was not done here
because one container is enough to demonstrate the behaviour and the policy
conflict is the part worth getting right.

---

## ADR-010 — Scenario A: split and fan out

**Decision.** Ingestion is two stages over durable state, both bounded in time
and memory.

```
vendor file in blob storage
        │
        │  POST /api/ingestion/jobs  ──▶ 202 Accepted  (O(1): one row, one message)
        ▼
  ┌───────────┐  streams, never parses, 64 KB buffer
  │ SPLITTER  │  emits byte ranges ─────────────────┐
  └───────────┘  out of time? persist cursor,       │
        ▲        re-enqueue self ──┐                │
        └────────────────────────┘                  ▼
                                          ┌──────────────────┐
                                          │ CHUNK PROCESSOR  │  × N in parallel
                                          │ 2,000 rows       │
                                          │ stream → price   │
                                          │ → batched upsert │
                                          └──────────────────┘
```

**How each constraint is met.**

*Timeout.* No stage runs long. A chunk is 2,000 rows and finishes in
milliseconds. The splitter is the only unbounded scan, so it carries a
self-imposed budget (`INGESTION_INVOCATION_BUDGET_MS`, default 90 s against a
300 s platform timeout) and yields **voluntarily** at a flush boundary,
persisting its byte cursor and re-enqueuing itself. It never waits to be
killed, because a process killed mid-transaction loses whatever it had not
persisted. Config validation refuses to boot if the budget is not below the
platform timeout.

*Memory.* Nothing ever holds the file. The splitter scans a fixed 64 KB buffer;
the processor streams one byte range and holds at most one 500-row upsert
batch. Peak worker RSS ingesting the 500,000-row file: **38 MB**, flat
throughout, against a 28 MB source file. The compose file caps the worker at
512 MB to make the constraint explicit.

*Stateless.* All progress lives in `ingestion_jobs.split_cursor` and
`ingestion_chunks`. The runtime holds nothing between invocations because it
cannot be trusted to.

*HTTP request does not drive the work.* The trigger endpoint writes one row,
enqueues one message, and returns `202`. It deliberately does **not** accept
the upload: pushing hundreds of megabytes through a request handler would hold
the request open for the whole job, which is the exact failure mode the design
exists to avoid. The file arrives in object storage out of band and the API is
merely notified of its key.

**Measured** — 500,000 rows, 28 MB, chunk size 2,000, concurrency 4:

| Metric | Result |
|---|---|
| Chunks created | 250 |
| Rows ingested | 499,800 (100 rejected, 100 duplicate SKUs collapsed) |
| Wall clock | ~4 s |
| Peak worker RSS | **38 MB** |
| Failed chunks | 0 |

**Resumability, verified rather than asserted.** The worker was `SIGKILL`ed
mid-run at 229/250 chunks — simulating a platform timeout kill — and restarted.
The job resumed and converged to **exactly 499,800 products**, with no
duplicates and no losses.

**Trade-off.** More moving parts than a single long-running job, and two extra
tables. That complexity is the price of the constraints: a single job cannot
run on a consumption plan at all, and any design without durable per-chunk
state restarts from zero after a failure nine tenths of the way through.

---

## ADR-011 — Idempotency, because delivery is at-least-once

**Decision.** Two independent mechanisms, on the assumption that every chunk
*will* eventually be delivered twice.

1. **A status gate.** `(job_id, seq)` is unique; claiming a chunk is a
   conditional update that skips anything already `COMPLETED`. A redelivery
   updates zero rows and returns without touching products.
2. **A convergent write.** The upsert is keyed on the vendor's SKU, so
   replaying it reaches the same state rather than duplicating rows.

Queue-level deterministic job ids add a third, weaker layer that discards
obvious duplicates before they reach a worker.

**A failure mode worth naming.** `INSERT ... ON CONFLICT DO UPDATE` raises
*"cannot affect row a second time"* if one statement touches the same conflict
target twice — and real vendor files repeat SKUs routinely, typically a
corrected line later in the same export. Without collapsing duplicates within
each batch first, the whole batch fails; worse, **every retry fails
identically**, so the chunk exhausts its attempts and is parked permanently.
Batches are de-duplicated before the write, last occurrence winning, matching
the vendor convention that a later line supersedes an earlier one.

A poison chunk is marked `FAILED` after `INGESTION_MAX_ATTEMPTS` and the job
continues. One bad chunk must not prevent the other 249 from landing; the job
reports partial failure rather than pretending to succeed.

**Trade-off.** Row counts reflect rows *written*, not lines read, since
duplicates collapse. The job tracks processed and rejected counts separately so
the difference is visible rather than mysterious.

---

## ADR-012 — Portable core, thin adapters

**Decision.** The pipeline is framework-free. Two adapters wrap it: an Azure
Functions queue trigger and a BullMQ worker. Neither contains business logic.

**Why.** The constraints in Scenario A are honoured by the *pipeline*, not by
the host. Making that structural means the same code is reviewable without a
cloud account, testable without emulators, and deployable to Lambda with a
ten-line handler. The compose worker is a faithful stand-in precisely because
it shares every line of the logic.

The Azure adapter documents the settings that actually matter on a consumption
plan — `functionTimeout` versus the invocation budget, `maxDequeueCount` versus
`INGESTION_MAX_ATTEMPTS`, and `batchSize` as the concurrency bound.

**The scaling hazard this makes visible.** A consumption plan scales to
hundreds of instances, and each concurrent chunk holds a Postgres connection.
Unbounded scale-out exhausts the database long before it exhausts the platform
— the classic way a "faster" ingestion pipeline becomes a slower one, or takes
down the storefront it feeds. Concurrency is therefore bounded explicitly
(`INGESTION_WORKER_CONCURRENCY`, `batchSize`), and a production deployment
should front Postgres with a pooler.

**Trade-off.** An indirection layer a cloud-native implementation would not
need, and the adapters can drift. Kept honest by giving them no logic to drift
*in*.

**An operational detail the container build exposed.** One image runs both the
API and the worker, which is deliberate — same code, same guarantees. But an
image-level `HEALTHCHECK` is then wrong by construction: the API's
`curl localhost:3000/health` marked the worker permanently unhealthy while it was
correctly draining the queue, because the worker serves no HTTP. In an
orchestrator that reads as a failing task and triggers restart loops. The probe
now lives per service — HTTP for the API, a TCP reachability check against Redis
for the worker, since a worker that cannot reach the queue consumes nothing
however alive its process looks.

---

## ADR-014 — Two pricing invariants, deliberately simple

**Decision.** The entire pricing policy is two rules, shared by the promotion
path and the ingestion pipeline:

1. **A price is strictly greater than zero.** Never free, never negative.
2. **A percentage discount is strictly less than 100%.**

Both are enforced in the database (`products_base_price_chk`,
`promotions_value_chk`, migration `0002`) and mirrored in
`src/domain/pricing.ts`, so they hold whichever path writes.

**Why rule 2 exists.** It serves rule 1. `value = 100` was previously legal,
which made "100% off all accessories" a single valid write that gave a whole
category away — and because effective price is resolved at read time (ADR-006),
it would have taken effect everywhere instantly, including on products ingested
afterwards. An exclusive bound removes the possibility rather than relying on
review to catch it.

**Why the floor is a floor and not a validation.** A fixed-amount discount may
legitimately exceed a product's price, so the read path clamps the result to one
cent instead of rejecting the promotion. It has to work this way: a category
promotion cannot know every price it will ever touch, including products ingested
after it was created, so the rule must be total rather than checked per product
at write time.

**What this replaced.** The ingestion pipeline previously carried a per-category
policy table — distinct markups, per-category margin floors, and charm-price
rounding to `.99`. It is now one flat markup over vendor cost
(`INGESTION_MARKUP_PERCENT`) under the shared floor. Beyond being less
configuration than the problem called for, the old arrangement created a real
inconsistency: ingestion enforced a margin floor while promotions merely clamped
at zero, so **vendor imports were better protected than manual price changes**.
One rule in one place removes that asymmetry.

**Trade-off.** Pricing is now less expressive than a real merchandising system
needs. Per-category or per-brand markups, margin protection, charm-price
rounding, currency-specific rounding, and tiered or stacking promotions are all
plausible future requirements, and none of them fit in two invariants. The
expectation is that **more complex pricing rules may well be implemented later**;
the structure anticipates it without pre-building it. `src/domain/pricing.ts` is
the single place both paths resolve prices through, so added rules land in one
module rather than being threaded through the ingestion and promotion code
separately — and the SQL/TypeScript parity test is what will keep a more
elaborate rule set honest across the two implementations.

## ADR-013 — Availability guards

**Decision.** Bound every request whose cost a caller can control, and ration
them per route class.

**Why.** A review found an unauthenticated request that cost ~380 ms of database
work and could be repeated indefinitely:

```
GET /api/products?at=<unique-timestamp>&page=400000
```

Two individually defensible decisions combined into it. `?at=` bypassed the
cache so simulations would not evict live entries (ADR-006), and `limit` was
capped at 100 while `page` was not (ADR-007). Neither is wrong alone; together
they produced an uncacheable query with an attacker-controlled `OFFSET`, in
front of a 20-connection pool with no rate limiting and no `statement_timeout`.
A handful of concurrent clients was enough to saturate Postgres.

**What was done.**

| Guard | Mechanism |
|---|---|
| Offset bound | `(page - 1) * limit <= MAX_PAGINATION_OFFSET`, rejected at the schema |
| Simulation cost | `?at=` snapped to the minute and cached; range bounded to ±400 days |
| Input validation | the detail route's `at` was parsed with a bare `new Date(String(...))`, accepting anything; now shares the list endpoint's validated schema |
| Request rationing | Redis-backed limiter, separate budgets for reads, simulations, writes and ingestion |
| Query duration | `statement_timeout` via the Postgres `options` connection parameter — 5 s API, 30 s worker |
| Fan-out | ingestion capped at `MAX_ACTIVE_INGESTION_JOBS` and de-duplicated per `fileKey` |

**Two trade-offs worth naming.**

*The limiter fails open.* If Redis is unreachable, requests are allowed and a
warning is logged. This is consistent with Redis being a performance tier and
never an availability dependency (ADR-009). The concession is that the service
is unprotected during a Redis outage; the alternative converts a cache outage
into a full storefront outage, which is strictly worse for a retail API.

*Identity is the client IP*, which is only meaningful if `trust proxy` is set
correctly — unset behind a load balancer every caller looks like the balancer,
and set to `true` the `X-Forwarded-For` header becomes caller-controlled and the
limiter is bypassable. It is therefore an explicit configuration value rather
than a default. Per-consumer budgets keyed on an authenticated principal would
be better and are the natural follow-on once authentication exists.

**What was deliberately *not* done,** and why: authentication, Redis ACLs,
least-privilege database roles, and security headers. All are real gaps — the API
has no authentication at all, the development database role is a superuser, and
Redis is unauthenticated. They are also larger changes than the brief called for,
and half-building authentication is worse than documenting its absence.

One item from the original review has since been closed rather than deferred: a
`PERCENTAGE` promotion of 100 was schema-legal and made a category free in one
write. Percentage discounts are now bounded exclusively below 100 and no price
may be zero — see ADR-014, which also removes the inconsistency whereby
ingestion enforced a margin floor that the promotion path did not.

## What I would do next

In priority order, with the trigger that would justify each:

1. **Keyset pagination** — when deep-page traffic or catalogue growth makes
   `OFFSET` costs visible. The total ordering it needs already exists.
2. **A materialised effective-price projection, refreshed on epoch change** —
   only if a single category grows past a few hundred thousand products and the
   sort in ADR-006 stops fitting the latency budget. It trades bounded
   staleness for an indexable sort key.
3. **Per-product epochs alongside the global one** — if single-product
   promotions become frequent enough that global invalidation hurts hit rates.
4. **A dead-letter queue with replay** — chunks currently park as `FAILED` and
   need manual intervention.
5. **Observability** — structured logging is in place; the metrics that matter
   are cache hit rate by tier, chunk duration distribution, and epoch bump
   frequency.
6. **Authentication with role separation** — storefront read, merchandiser
   write, vendor-sync trigger — and an actor recorded on every promotion
   mutation. Rate limiting now exists (ADR-013) but is keyed on IP, which is the
   best available identity only because there is no authenticated principal yet.
7. **An approval threshold for large discounts** — a 99% promotion is now legal
   where 100% is not, and nothing but the bound stops one being created. The
   natural control is a second approver above some depth, which needs the actor
   identity that authentication would provide.
8. **Richer pricing rules** when merchandising asks for them: per-category or
   per-brand markups, margin protection, charm-price rounding, stacking or tiered
   promotions. ADR-014 keeps the policy to two invariants on purpose, and routes
   both paths through one module so this can grow in one place.

## Known limitations

- Single-flight protection is per-process, not distributed. With N replicas, a
  cold key can trigger N loads rather than one.
- `COUNT(*)` for pagination metadata is exact, and therefore a full scan on
  large categories. It is cached separately and deliberately not epoch-stamped,
  since product counts do not change when promotions do.
- The L1 tier permits up to `CACHE_L1_TTL_MS` of price staleness (ADR-009).
- No authentication or authorisation. Rate limiting exists but is keyed on
  client IP and fails open when Redis is unavailable (ADR-013).
- Point-in-time simulations are accurate to the minute, not the second.
- Pricing supports one flat ingestion markup and a single discount per product.
  No per-category margin rules, charm-price rounding, or stacking (ADR-014).
