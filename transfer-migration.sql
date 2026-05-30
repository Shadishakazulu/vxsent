-- ============================================================
-- SENT Transfer ("Verified Bill of Sale") — Migration
-- Run in the Supabase SQL Editor. Safe to run once (idempotent).
--
-- Data model: ONE universal record for ANY sale (title, description,
-- condition, price, parties, date, PROVENANCE) plus a lightweight
-- per-category adapter (category_attributes JSONB) that holds the
-- extra fields a category needs WITHOUT separate tables/forms:
--   sneakers    -> { size, sku, authentication }
--   jewelry     -> { metal, stones, appraisal_cert }
--   electronics -> { serial, imei }
--   general     -> {}
-- Provenance and evidence are first-class and are sealed into the
-- cryptographic agreement hash.
-- ============================================================

-- Main transfers table
CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,                       -- SENT-TX-YYYY-XXXXXXXX
  user_id BIGINT,                            -- seller's users.id (nullable for guest single-transfer)
  seller_email TEXT NOT NULL,
  seller_name TEXT NOT NULL,
  seller_phone TEXT,

  buyer_email TEXT NOT NULL,
  buyer_name TEXT NOT NULL,
  buyer_phone TEXT,

  -- Universal core — applies to ANY sale
  item_title TEXT NOT NULL,
  category TEXT,                             -- sneakers | jewelry | electronics | general
  sale_price NUMERIC(12,2),
  transfer_date DATE,
  description TEXT,
  condition TEXT,                            -- New | Excellent | Good | Fair | As-Is | Salvage | Custom
  condition_custom TEXT,
  provenance TEXT,                           -- ownership / authenticity history (first-class, sealed)
  category_attributes JSONB NOT NULL DEFAULT '{}'::jsonb,  -- per-category adapter fields
  location TEXT,
  notes TEXT,

  -- Disclosures (free text the seller explicitly declares)
  disclosed_defects TEXT,
  disclosed_damage TEXT,
  disclosed_missing_parts TEXT,
  disclosed_repairs TEXT,
  disclosed_special_conditions TEXT,

  -- Structured agreement toggles
  sold_as_is BOOLEAN DEFAULT FALSE,
  no_warranty BOOLEAN DEFAULT FALSE,
  buyer_inspected BOOLEAN DEFAULT FALSE,
  inspection_completed BOOLEAN DEFAULT FALSE,
  buyer_acknowledged_condition BOOLEAN DEFAULT FALSE,

  -- Proof package
  agreement_hash TEXT,                       -- sha256 of canonical agreement JSON (incl. provenance + attributes + evidence)
  rac_chain_hash TEXT,                       -- identity:scope:transfer:timestamp chain
  veridex_signature TEXT,
  sealed_at TIMESTAMPTZ,                     -- when seller sealed

  -- Buyer acknowledgment (Layer 4)
  buyer_confirmed BOOLEAN DEFAULT FALSE,
  buyer_confirmed_at TIMESTAMPTZ,
  buyer_confirmation_hash TEXT,
  buyer_confirm_ip TEXT,

  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | sealed | acknowledged
  is_valid BOOLEAN DEFAULT FALSE,            -- true once sealed
  payment_ref TEXT,                          -- stripe ref or '<plan>_plan' or 'single_transfer'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- If an earlier (vehicle-flavoured) version of this table already exists,
-- add the two new columns without touching existing data.
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS provenance TEXT;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS category_attributes JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_transfers_user_id ON transfers (user_id);
CREATE INDEX IF NOT EXISTS idx_transfers_seller_email ON transfers (seller_email);
CREATE INDEX IF NOT EXISTS idx_transfers_buyer_email ON transfers (buyer_email);
CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfers (status);
CREATE INDEX IF NOT EXISTS idx_transfers_created_at ON transfers (created_at DESC);

-- Evidence files (one row per uploaded photo/video/pdf/doc)
CREATE TABLE IF NOT EXISTS transfer_evidence (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  transfer_id TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_hash TEXT NOT NULL,                   -- sha256 hex, computed client-side
  file_mime_type TEXT,
  file_size_bytes BIGINT,
  file_size TEXT,                            -- human readable
  storage_path TEXT NOT NULL,                -- path in transfer-evidence bucket
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sort_order INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_transfer_evidence_transfer ON transfer_evidence (transfer_id);

-- updated_at trigger
CREATE OR REPLACE FUNCTION transfers_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_transfers_updated_at ON transfers;
CREATE TRIGGER trg_transfers_updated_at BEFORE UPDATE ON transfers
  FOR EACH ROW EXECUTE FUNCTION transfers_set_updated_at();

-- ============================================================
-- STORAGE BUCKET (one-time, via Supabase dashboard or the SQL below)
-- ============================================================
-- Create a PRIVATE bucket named 'transfer-evidence' with a 100MB file limit.
-- Evidence is permanent (unlike gated proof-files which auto-delete) — the
-- record's long-term value is the sealed proof of condition & provenance.
--
-- Dashboard: Storage > New bucket > name "transfer-evidence", Public = OFF,
--            File size limit = 100MB.
--
-- Or run this (idempotent):
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('transfer-evidence', 'transfer-evidence', false, 104857600)
ON CONFLICT (id) DO UPDATE
  SET public = false, file_size_limit = 104857600;

-- ============================================================
-- Admin queries
-- ============================================================
-- All transfers:
--   SELECT id, seller_email, buyer_email, item_title, category, sale_price, status, sealed_at, rac_chain_hash
--   FROM transfers ORDER BY created_at DESC;
-- Evidence for one transfer:
--   SELECT file_name, file_hash, file_size FROM transfer_evidence WHERE transfer_id = 'SENT-TX-2026-XXXXXXXX';
