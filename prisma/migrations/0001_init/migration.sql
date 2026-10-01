-- ===========================================================================
-- ModaCo Promotion Management API — initial schema
--
-- This file is the authoritative DDL for the submission. It is applied by
-- `prisma migrate deploy` and mirrored to ./schema.sql in the repo root.
--
-- Design note: the business rule "a product can have at most one active
-- promotion at a time" is enforced by the database, not by the application.
-- An application-level "SELECT then INSERT" check cannot hold this invariant
-- under concurrency: two simultaneous requests both read "no conflict" and
-- both insert. The GiST EXCLUDE constraints below make that outcome
-- impossible regardless of how many API instances are running.
-- ===========================================================================

-- btree_gist lets a GiST index mix scalar equality (uuid, text) with the
-- range-overlap operator, which is what the EXCLUDE constraints need.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- --------------------------------------------------------------------------
-- Enumerated types
-- --------------------------------------------------------------------------
CREATE TYPE discount_type            AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');
CREATE TYPE promotion_scope          AS ENUM ('PRODUCT', 'CATEGORY');
CREATE TYPE promotion_status         AS ENUM ('ACTIVE', 'CANCELLED');
CREATE TYPE ingestion_job_status     AS ENUM ('SPLITTING', 'PROCESSING', 'COMPLETED', 'FAILED');
CREATE TYPE ingestion_chunk_status   AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

-- --------------------------------------------------------------------------
-- products
-- --------------------------------------------------------------------------
CREATE TABLE products (
    id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    sku            TEXT         NOT NULL,
    name           TEXT         NOT NULL,
    category       TEXT         NOT NULL,
    base_price     NUMERIC(12,2) NOT NULL,
    stock_quantity INTEGER      NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT products_base_price_chk     CHECK (base_price >= 0),
    CONSTRAINT products_stock_quantity_chk CHECK (stock_quantity >= 0)
);

-- SKU is the vendor-supplied natural key. The ingestion pipeline upserts on
-- it (ON CONFLICT (sku)), so this unique index is load-bearing, not cosmetic.
CREATE UNIQUE INDEX products_sku_key ON products (sku);

-- Supports `?category=` filtering.
CREATE INDEX products_category_idx ON products (category);

-- Supports the common "filter by category, order by price" access pattern.
-- It cannot serve ORDER BY effective_price directly (see the ADR), but it
-- does let Postgres reach the candidate rows with an index scan before the
-- promotion join is applied.
CREATE INDEX products_category_base_price_idx ON products (category, base_price);

-- Stable tiebreaker for keyset pagination.
CREATE INDEX products_created_at_id_idx ON products (created_at DESC, id DESC);

-- --------------------------------------------------------------------------
-- promotions
-- --------------------------------------------------------------------------
CREATE TABLE promotions (
    id            UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT             NOT NULL,
    discount_type discount_type    NOT NULL,
    value         NUMERIC(12,2)    NOT NULL,
    scope         promotion_scope  NOT NULL,
    product_id    UUID             REFERENCES products (id) ON DELETE CASCADE,
    category      TEXT,
    starts_at     TIMESTAMPTZ(6)   NOT NULL,
    ends_at       TIMESTAMPTZ(6)   NOT NULL,
    status        promotion_status NOT NULL DEFAULT 'ACTIVE',
    cancelled_at  TIMESTAMPTZ(6),
    created_at    TIMESTAMPTZ(6)   NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ(6)   NOT NULL DEFAULT now(),

    -- The scope discriminator and its payload must agree. Without this, a
    -- row can claim scope='CATEGORY' while carrying a product_id, and the
    -- resolution query would silently mis-attribute the discount.
    CONSTRAINT promotions_scope_payload_chk CHECK (
        (scope = 'PRODUCT'  AND product_id IS NOT NULL AND category   IS NULL) OR
        (scope = 'CATEGORY' AND category   IS NOT NULL AND product_id IS NULL)
    ),

    CONSTRAINT promotions_window_chk CHECK (ends_at > starts_at),

    -- A percentage discount above 100 would invert the price; a non-positive
    -- discount is not a promotion.
    CONSTRAINT promotions_value_chk CHECK (
        value > 0 AND (discount_type <> 'PERCENTAGE' OR value <= 100)
    ),

    CONSTRAINT promotions_cancelled_at_chk CHECK (
        (status = 'CANCELLED') = (cancelled_at IS NOT NULL)
    )
);

-- --------------------------------------------------------------------------
-- The core business invariant.
--
-- Two ACTIVE promotions of the same scope may never cover overlapping time
-- windows for the same target. Expressed as EXCLUDE constraints, Postgres
-- rejects the second writer even when both transactions are in flight
-- simultaneously — the guarantee holds across every API replica.
--
-- The window is treated as half-open '[)' so that a promotion ending at
-- 12:00 and the next starting at exactly 12:00 is a clean handover, not a
-- conflict. This is a deliberate product decision, documented in the ADR.
--
-- PRODUCT-scope and CATEGORY-scope promotions are intentionally NOT mutually
-- exclusive: a product may be covered by both at once. That is not a conflict
-- to reject, it is a precedence question, and it is resolved deterministically
-- at read time (product beats category). See src/domain/promotion-resolution.ts.
-- --------------------------------------------------------------------------
ALTER TABLE promotions
    ADD CONSTRAINT promotions_no_overlap_per_product
    EXCLUDE USING gist (
        product_id WITH =,
        tstzrange(starts_at, ends_at, '[)') WITH &&
    ) WHERE (status = 'ACTIVE' AND scope = 'PRODUCT');

ALTER TABLE promotions
    ADD CONSTRAINT promotions_no_overlap_per_category
    EXCLUDE USING gist (
        category WITH =,
        tstzrange(starts_at, ends_at, '[)') WITH &&
    ) WHERE (status = 'ACTIVE' AND scope = 'CATEGORY');

-- Partial indexes: only ACTIVE promotions are ever resolved, and the active
-- set stays small (tens to hundreds) even when the catalogue is in the
-- millions. Keeping these indexes narrow is what makes read-time promotion
-- resolution affordable — see Scenario B in the ADR.
CREATE INDEX promotions_active_product_idx
    ON promotions (product_id, starts_at, ends_at)
    WHERE status = 'ACTIVE' AND scope = 'PRODUCT';

CREATE INDEX promotions_active_category_idx
    ON promotions (category, starts_at, ends_at)
    WHERE status = 'ACTIVE' AND scope = 'CATEGORY';

-- Serves "give me every promotion in force right now", the query that warms
-- the resolution cache.
CREATE INDEX promotions_active_window_idx
    ON promotions (starts_at, ends_at)
    WHERE status = 'ACTIVE';

-- --------------------------------------------------------------------------
-- ingestion_jobs / ingestion_chunks  (Scenario A)
--
-- A serverless runtime gives us no durable memory: the process dies when the
-- request ends. These tables are the pipeline's memory. Every unit of work
-- records where it got to, so any invocation can be killed at any moment and
-- the next one resumes from the last durable point rather than from zero.
-- --------------------------------------------------------------------------
CREATE TABLE ingestion_jobs (
    id              UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
    file_key        TEXT                NOT NULL,
    status          ingestion_job_status NOT NULL DEFAULT 'SPLITTING',
    total_bytes     BIGINT              NOT NULL,
    -- How far the splitter has scanned. A splitter that hits its time budget
    -- persists this and re-enqueues itself to continue from exactly here.
    split_cursor    BIGINT              NOT NULL DEFAULT 0,
    split_completed BOOLEAN             NOT NULL DEFAULT FALSE,
    chunks_total    INTEGER             NOT NULL DEFAULT 0,
    rows_processed  BIGINT              NOT NULL DEFAULT 0,
    rows_rejected   BIGINT              NOT NULL DEFAULT 0,
    error           TEXT,
    created_at      TIMESTAMPTZ(6)      NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ(6)      NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ(6)
);

CREATE INDEX ingestion_jobs_status_idx ON ingestion_jobs (status);

CREATE TABLE ingestion_chunks (
    id             UUID                   PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id         UUID                   NOT NULL REFERENCES ingestion_jobs (id) ON DELETE CASCADE,
    seq            INTEGER                NOT NULL,
    byte_start     BIGINT                 NOT NULL,
    byte_end       BIGINT                 NOT NULL,
    status         ingestion_chunk_status NOT NULL DEFAULT 'PENDING',
    attempts       INTEGER                NOT NULL DEFAULT 0,
    rows_processed INTEGER                NOT NULL DEFAULT 0,
    rows_rejected  INTEGER                NOT NULL DEFAULT 0,
    error          TEXT,
    created_at     TIMESTAMPTZ(6)         NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ(6)         NOT NULL DEFAULT now(),

    CONSTRAINT ingestion_chunks_range_chk CHECK (byte_end > byte_start)
);

-- The idempotency key. Queues deliver at-least-once, so the same chunk WILL
-- be handed to a worker more than once. (job_id, seq) lets a redelivery
-- recognise already-COMPLETED work and return without touching products.
CREATE UNIQUE INDEX ingestion_chunks_job_seq_key ON ingestion_chunks (job_id, seq);

CREATE INDEX ingestion_chunks_job_status_idx ON ingestion_chunks (job_id, status);
