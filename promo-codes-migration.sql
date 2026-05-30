-- ============================================================
-- SENT. — Promo codes (100%-off / free-current-item coupons)
-- Run in the Supabase SQL Editor. Safe to run repeatedly (idempotent).
--
-- LAUNCH7 is a 100%-OFF coupon: it makes the customer's CURRENT one-time
-- purchase FREE — no card charged.
--   - Day Pass ($0.99 proof)        → issued for free
--   - Single Transfer ($4.99 fee)   → OUR verification fee is waived; the
--                                     buyer/seller sale is untouched
-- It is NOT a Solo membership / trial grant.
--
-- These two tables back the promo-code box shown under "Card details" on the
-- Day Pass (index_updated.html) and single-Transfer (transfer.html) flows.
-- Redemption is handled server-side by netlify/functions/redeem-promo.js, which:
--   - validates the code (active, not expired, under max_uses, 100%-off),
--   - enforces ONE redemption per customer via promo_redemptions,
--   - claims the redemption BEFORE delivery (unique (code,email) is the guard),
--   - seals/delivers the product with NO Stripe charge, and
--   - records what was redeemed (product + reference_id).
-- ============================================================

-- Available codes
CREATE TABLE IF NOT EXISTS promo_codes (
  code         TEXT PRIMARY KEY,            -- stored UPPERCASE (e.g. LAUNCH7)
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  plan_granted TEXT,                        -- legacy membership codes only; NULL for coupons
  trial_days   INTEGER,                     -- legacy membership codes only; NULL for coupons
  max_uses     INTEGER,                     -- NULL = no overall cap (per-customer cap still applies)
  times_used   INTEGER NOT NULL DEFAULT 0,  -- incremented on each redemption
  expires_at   TIMESTAMPTZ,                 -- NULL = never expires
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- New coupon columns (additive; safe if the table already existed with the old shape).
ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS kind        TEXT NOT NULL DEFAULT 'membership';
ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS percent_off INTEGER;

-- The old schema marked plan_granted/trial_days NOT NULL (for Solo grants).
-- A 100%-off coupon has neither, so relax those constraints.
ALTER TABLE promo_codes ALTER COLUMN plan_granted DROP NOT NULL;
ALTER TABLE promo_codes ALTER COLUMN trial_days   DROP NOT NULL;

-- One row per (code, email) redemption — the unique constraint is the backstop
-- that genuinely enforces "one free purchase per customer".
CREATE TABLE IF NOT EXISTS promo_redemptions (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code         TEXT NOT NULL REFERENCES promo_codes(code),
  email        TEXT NOT NULL,
  trial_days   INTEGER,
  redeemed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT promo_redemptions_code_email_unique UNIQUE (code, email)
);

-- Record what each redemption delivered (additive).
ALTER TABLE promo_redemptions ALTER COLUMN trial_days DROP NOT NULL;
ALTER TABLE promo_redemptions ADD COLUMN IF NOT EXISTS product      TEXT;  -- 'day_pass' | 'single_transfer'
ALTER TABLE promo_redemptions ADD COLUMN IF NOT EXISTS reference_id TEXT;  -- proof id / transfer id sealed

CREATE INDEX IF NOT EXISTS idx_promo_redemptions_email ON promo_redemptions (email);

-- ============================================================
-- Seed / correct LAUNCH7: 100%-off coupon, one redemption per customer, active.
-- If LAUNCH7 was previously seeded as a 7-day Solo grant, this UPDATES it to the
-- corrected free-purchase behavior and clears the membership fields.
-- ============================================================
INSERT INTO promo_codes (code, active, kind, percent_off, plan_granted, trial_days, max_uses, times_used, expires_at)
VALUES ('LAUNCH7', TRUE, 'free_purchase', 100, NULL, NULL, NULL, 0, NULL)
ON CONFLICT (code) DO UPDATE
  SET active       = TRUE,
      kind         = 'free_purchase',
      percent_off  = 100,
      plan_granted = NULL,
      trial_days   = NULL;
