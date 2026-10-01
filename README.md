# ModaCo — Promotion Management API

Internal API for ModaCo's product catalogue and promotions, built for two
operational realities that ordinary CRUD does not survive: weekly 500,000-row
vendor imports on a serverless plan, and flash sales that reprice 50,000+
products while the storefront is under peak read load.

**Node.js · TypeScript · Express · PostgreSQL 16 · Prisma · Redis · BullMQ**

📄 **[ADR.md](./ADR.md)** — architecture decisions, trade-offs, and measured results
📄 **[AI_APPENDIX.md](./AI_APPENDIX.md)** — Form 5, AI collaboration and error correction
📄 **[schema.sql](./schema.sql)** — complete DDL
📮 **[postman/](./postman)** — 44-request collection covering every endpoint, both scenarios, and the availability guards

---

## The two problems, in one paragraph each

**Scenario A — 500,000 rows on a serverless plan.** The file is never loaded.
A splitter streams it with a fixed 64 KB buffer, emitting byte ranges into a
queue; each range is ingested by a short-lived, idempotent worker. Progress is
durable per chunk, so any invocation can be killed at any moment and the next
resumes from the last completed chunk. The splitter itself yields on a
self-imposed time budget and re-enqueues itself, so a file of any size spans as
many invocations as it needs. *Measured: 500,000 rows in ~4 s at a peak worker
RSS of **38 MB**; `SIGKILL` at 229/250 chunks resumed and converged to exactly
the right row count.*

**Scenario B — flash sales.** Effective price is never stored. Creating "50% off
all accessories" writes **one row** and increments **one integer**; every
derived cache entry becomes logically stale at once, and effective price is
resolved at read time against the small set of active promotions. Because
nothing is denormalised, a product created *during* the sale gets the discount
automatically. *Measured: creating a sale affecting 62,500 products takes
11.5 ms and updates **zero** product rows.*

---

## Quick start

### Docker (everything)

```bash
cp .env.example .env
docker compose up --build
```

Brings up Postgres, Redis, migrations, the API on `:3000`, and a separate
ingestion worker. All four services report `healthy`.

The runtime image has no dev dependencies, so `npm run seed` (which uses `tsx`)
does not work inside it. Use the compiled entrypoints:

```bash
docker compose run --rm --no-deps api node dist/scripts/seed.js
docker compose run --rm --no-deps api node dist/scripts/generate-vendor-file.js 500000
```

`./storage` is bind-mounted into both the API and the worker, so a vendor file
generated on the host is visible to the containers and vice versa.

If ports `5432`/`6379` are already taken by a local Postgres or Redis, stop those
first — the compose file publishes both.

### Local (Node + your own Postgres/Redis)

```bash
npm install
cp .env.example .env          # edit DATABASE_URL / REDIS_URL if needed
npx prisma migrate deploy
npx prisma generate

npm run dev                   # API   → http://localhost:3000
npm run worker                # ingestion worker, in a second terminal
```

```bash
npm run seed                  # 6 products + 2 promotions that show precedence
npm test                      # 25 tests against a live Postgres
```

---

## Postman

```
postman/ModaCo.postman_collection.json
postman/ModaCo-Local.postman_environment.json
```

Import both into Postman, select the **ModaCo — Local** environment, and run the
folders top to bottom. `productId`, `promotionId` and `jobId` are captured
automatically by test scripts, so nothing needs copy-pasting — just run
**Products → List products** first to populate `productId`.

| Folder | What it covers |
|---|---|
| **Health** | Liveness; Redis reported separately from health |
| **Products** | Filtering, pagination, all four sorts, point-in-time pricing, cache tiers, 400/404 paths |
| **Promotions** | Create (both scopes), list, get, assign, cancel, idempotent re-cancel |
| **Scenario B — Flash Sale Walkthrough** | 7 ordered steps: baseline → create sale → assert instant invalidation → cache hit → conflict refused → cancel → prices restored |
| **Scenario A — Bulk Ingestion** | Trigger the 500k-row import and self-poll to completion |
| **Validation & Conflicts** | 409 overlap, adjacent-window acceptance, the bounded pagination offset, and each 400/404 path labelled with the layer that rejected it |

The collection is **executable, not just documentation** — 280 assertions, all
passing, verified against both the local stack and the Docker stack:

```bash
npx newman run postman/ModaCo.postman_collection.json \
  -e postman/ModaCo-Local.postman_environment.json --delay-request 300
```

```
requests      58 executed, 0 failed      ← 44 defined + 14 ingestion polls
assertions   280 executed, 0 failed
duration    19.7s   avg response 14ms
```

Two details worth knowing:

- **Scenario A requires `npm run worker`** and a generated vendor file. Its
  *Poll job status* request re-runs itself until the job is terminal, capped at
  60 polls; set a ~1000 ms Runner delay so it is not tight-looped.
- The **List products** tests assert `effectivePrice` is *numerically*
  non-decreasing. That guard exists because this endpoint once sorted
  lexicographically — `'100.00'` before `'30.00'` — while still returning a
  perfectly plausible ordered list. See ADR-007.

---

## Seeing it work

### Promotion precedence

```bash
npm run seed
curl 'localhost:3000/api/products?category=accessories&sort=effective_price'
```

| Product | Base | Effective | Why |
|---|---|---|---|
| Leather Belt | 89.00 | **59.00** | Product-scope promotion outranks the category flash sale |
| Silk Scarf | 129.00 | **64.50** | Category flash sale, 50% off |
| Wool Gloves | 45.00 | **22.50** | Category flash sale, 50% off |
| Trench Coat | 450.00 | 450.00 | Not in the promoted category |

### A flash sale takes effect instantly

```bash
curl -X POST localhost:3000/api/promotions -H 'content-type: application/json' -d '{
  "name": "Flash — 40% Off Outerwear", "discountType": "PERCENTAGE", "value": 40,
  "scope": "CATEGORY", "category": "outerwear",
  "startsAt": "2020-01-01T00:00:00Z", "endsAt": "2030-01-01T00:00:00Z" }'

curl 'localhost:3000/api/products?category=outerwear'   # every price already updated
```

Add a product to `outerwear` afterwards and it carries the discount with no
backfill — nothing was denormalised, so there is nothing to backfill.

### Conflicting promotions are refused

```bash
# A second overlapping ACTIVE promotion on the same category → 409
curl -i -X POST localhost:3000/api/promotions -H 'content-type: application/json' -d '{
  "name":"Competing Sale","discountType":"PERCENTAGE","value":25,
  "scope":"CATEGORY","category":"outerwear",
  "startsAt":"2025-06-01T00:00:00Z","endsAt":"2026-12-01T00:00:00Z" }'
```

Enforced by a GiST `EXCLUDE` constraint, so it holds under concurrent writes
across every replica — not by a service-layer check that two simultaneous
requests can both pass. `npm test` proves it with ten concurrent writers.

### Ingest 500,000 rows

```bash
npm run generate:vendor-file -- 500000        # ~28 MB into ./storage
npm run worker                                 # in a second terminal
npm run ingest                                 # trigger + live progress
```

```
[ 1s] SPLITTING   chunks   0/50   rows       0  rejected    0  workerRSS 38MB
[ 3s] PROCESSING  chunks 168/250  rows 335,865  rejected   67  workerRSS 38MB
[ 5s] COMPLETED   chunks 250/250  rows 499,800  rejected  100  workerRSS 38MB
```

The generated file deliberately contains duplicate SKUs, quoted fields with
embedded newlines, and malformed rows — each exercising a specific failure mode
documented in ADR-011.

Vendor prices are not written through untouched: every row passes the
application-layer pricing rules first, which apply a flat markup over vendor cost
under a one-cent minimum. Pricing policy is deliberately just two invariants —
**nothing is ever free, and no percentage discount reaches 100%** — shared by the
ingestion pipeline and the promotion path alike. See **ADR-014**, which also notes
that richer rules (per-category margins, charm pricing, stacking) are expected
later and where they would go.

**Kill the worker mid-run and restart it.** The job resumes from its last
completed chunk. That is the serverless timeout behaviour, reproduced locally.

---

## API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Reports Redis separately; Redis down ≠ unhealthy |
| `GET` | `/api/products` | `category`, `page`, `limit`, `sort`, `direction`, `at` |
| `GET` | `/api/products/:id` | Hottest endpoint; two-tier cached |
| `POST` | `/api/promotions` | Product- or category-scoped |
| `GET` | `/api/promotions` | `status`, `scope`, `category`, `productId`, `activeAt` |
| `POST` | `/api/promotions/:id/cancel` | Cancels, never deletes — promotions are an audit trail |
| `POST` | `/api/promotions/:id/assign` | Re-target to a product or category |
| `POST` | `/api/ingestion/jobs` | `202` + job id; takes a blob key, not an upload |
| `GET` | `/api/ingestion/jobs/:id` | Progress, per-chunk state, rejected-row counts |

`sort=effective_price` sorts by the *computed* price, not the base price.
`?at=<iso8601>` prices the catalogue at any instant, which makes a scheduled
flash sale verifiable before it goes live; the instant is snapped to the minute
so repeated simulations are cacheable rather than costing a full query each time.
Responses carry `X-Cache: l1|l2|miss|bypass` so caching behaviour is observable,
and `X-RateLimit-*` headers report the remaining budget for the route class.

Every route sits behind a per-class rate limiter, the pagination offset is
bounded, and queries carry a `statement_timeout`. These close a measured
denial-of-service vector — see **ADR-013**.

---

## Layout

```
src/
  domain/          pure logic — money, pricing, promotion precedence
  modules/
    products/      hand-written SQL for the two hot reads
    promotions/    writes; conflict translation; epoch invalidation
  ingestion/       Scenario A — splitter, chunk processor, pricing rules
  adapters/
    azure-functions/   serverless queue trigger
    local-runner/      BullMQ worker (same pipeline, no logic of its own)
  cache/           epoch invalidation, two-tier read-through cache
prisma/migrations/ authoritative DDL (mirrored to ./schema.sql)
tests/             50 tests against a live Postgres
```

The ingestion pipeline imports neither Express nor BullMQ. The adapters contain
no business logic. That is what makes the local worker a faithful stand-in for
the serverless deployment rather than an approximation of it.

---

## Configuration

Full list in `.env.example`. The ones that change behaviour:

| Variable | Default | Effect |
|---|---|---|
| `INGESTION_CHUNK_ROWS` | `2000` | Rows per serverless invocation |
| `INGESTION_INVOCATION_BUDGET_MS` | `90000` | Self-imposed yield point; must stay below the platform timeout (validated at boot) |
| `INGESTION_WORKER_CONCURRENCY` | `4` | Concurrent chunks — each holds a DB connection |
| `CACHE_L1_TTL_MS` | `1000` | **Also the worst-case price staleness window** (ADR-009) |
| `CACHE_ENABLED` | `true` | Set `false` to serve everything from Postgres |
| `MAX_PAGINATION_OFFSET` | `10000` | Caps `(page-1)*limit`; sorting by effective price cannot use an index |
| `RATE_LIMIT_*_PER_MIN` | varies | Per-class budgets; the limiter **fails open** if Redis is down |
| `TRUST_PROXY` | `loopback` | Decides what `req.ip` is, and therefore what the limiter keys on |
| `MAX_ACTIVE_INGESTION_JOBS` | `3` | One trigger fans out to ~250 chunk jobs |
| `INGESTION_MARKUP_PERCENT` | `30` | Flat markup over vendor cost; the whole of the ingestion pricing rule |

## Testing

```bash
npm test          # 50 tests, live Postgres
npm run typecheck
```

Tests run against a real database rather than mocks, because the most important
guarantees are database guarantees: the concurrency test asserts that exactly
one of ten simultaneous writers wins, and the pricing test verifies 96
base/discount combinations produce byte-identical results in SQL and
TypeScript. Neither is meaningful against a mock.
