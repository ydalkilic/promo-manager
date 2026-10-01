-- ===========================================================================
-- Tighten the pricing invariants.
--
-- Two rules, enforced in the database so they hold regardless of which code
-- path writes, and mirrored in src/domain/pricing.ts for the application:
--
--   1. A price is strictly greater than zero. Nothing is ever free.
--   2. A percentage discount is strictly below 100%.
--
-- Rule 2 exists to serve rule 1. `value = 100` was previously legal, which made
-- "100% off this category" a single valid write that gave an entire catalogue
-- away. Combined with the read-time resolution design — one row written, every
-- product in the category repriced instantly — that was the highest-impact
-- business-logic gap in the schema.
--
-- These replace the permissive originals rather than adding to them, so the
-- constraint names are reused.
-- ===========================================================================

-- A product priced at zero cannot be sold; it can only be given away.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_base_price_chk;
ALTER TABLE products
    ADD CONSTRAINT products_base_price_chk CHECK (base_price > 0);

-- Strictly less than 100 for a percentage. A fixed amount may still exceed the
-- base price — it is applied against many products, including ones ingested
-- after the promotion was created, so it cannot be validated per-product at
-- write time. The read path floors the result at 0.01 instead, which is why the
-- rule has to live in the pricing functions as well as here.
ALTER TABLE promotions DROP CONSTRAINT IF EXISTS promotions_value_chk;
ALTER TABLE promotions
    ADD CONSTRAINT promotions_value_chk CHECK (
        value > 0 AND (discount_type <> 'PERCENTAGE' OR value < 100)
    );
