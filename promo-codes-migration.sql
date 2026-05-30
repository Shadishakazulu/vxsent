-- ============================================================
-- SENT. — Promo codes (Solo membership trials)
-- Run in the Supabase SQL Editor. Safe to run repeatedly (idempotent).
--
-- These two tables back the promo-code box shown under "Card details" on the
-- day-pass (index_updated.html) and single-transfer (transfer.html) flows, and
-- the promo field on the login page. Redemption is handled server-side by
-- netlify/functions/auth-magic-link.js, which:
--   - validates the code (active, not expired, under max_uses),
--   - enforces ONE use per email via promo_redemptions,
--   - grants the Solo plan on the users row (plan + plan_expires_at), and
--   - emails a magic link so the user signs in and activates the trial.
-- ============================================================

-- Available codes
CREATE TABLE IF NOT EXISTS promo_codes (
  code         TEXT PRIMARY KEY,            -- stored UPPERCASE (e.g. LAUNCH7)
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  plan_granted TEXT NOT NULL DEFAULT 'solo',-- plan the code grants
  trial_days   INTEGER NOT NULL DEFAULT 7,  -- length of the granted membership
  max_uses     INTEGER,                     -- NULL = unlimited redemptions overall
  times_used   INTEGER NOT NULL DEFAULT 0,  -- incremented on each redemption
  expires_at   TIMESTAMPTZ,                 -- NULL = never expires
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (code, email) redemption — the unique constraint is the backstop
-- that enforces "one use per user".
CREATE TABLE IF NOT EXISTS promo_redemptions (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT NOT NULL REFERENCES promo_codes(code),
  email       TEXT NOT NULL,
  trial_days  INTEGER NOT NULL DEFAULT 7,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT promo_redemptions_code_email_unique UNIQUE (code, email)
);

CREATE INDEX IF NOT EXISTS idx_promo_redemptions_email ON promo_redemptions (email);

-- Seed the launch code: 7-day Solo membership, one use per user, no overall cap.
INSERT INTO promo_codes (code, active, plan_granted, trial_days, max_uses, times_used, expires_at)
VALUES ('LAUNCH7', TRUE, 'solo', 7, NULL, 0, NULL)
ON CONFLICT (code) DO UPDATE
  SET active       = TRUE,
      plan_granted = 'solo',
      trial_days   = 7;
