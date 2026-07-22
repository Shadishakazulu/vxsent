-- ============================================================
-- VX Pay ("Escrowed Payment Agreement") — Supabase Migration
-- Run in the Supabase SQL Editor. Idempotent. Mirrors transfer-migration.sql.
--
-- VX Pay is the escrow member of the VX family:
--   SENT     -> proof of delivery
--   Transfer -> verified bill of sale
--   VX Pay   -> escrowed payment agreement (fund -> deliver -> acknowledge -> release)
--
-- Same proof engine as Transfer: canonical agreement hash + SHA-256 RAC chain
-- + Veridex signature (Ed25519 when configured, SHA-256 fallback otherwise),
-- so a VX Pay agreement verifies through the SAME /verify/:id surface.
-- ============================================================

CREATE TABLE IF NOT EXISTS vxpay_agreements (
  id TEXT PRIMARY KEY,                        -- VXPAY-YYYY-XXXXXXXX
  user_id BIGINT,                             -- creator's users.id (buyer or seller)
  created_by_role TEXT NOT NULL DEFAULT 'buyer', -- buyer | seller (who opened it)

  buyer_email TEXT NOT NULL,
  buyer_name TEXT NOT NULL,
  buyer_phone TEXT,

  seller_email TEXT NOT NULL,
  seller_name TEXT NOT NULL,
  seller_phone TEXT,

  -- Deal core
  item_title TEXT NOT NULL,
  category TEXT,                              -- sneakers | jewelry | electronics | general
  amount NUMERIC(12,2) NOT NULL,             -- escrow amount agreed
  currency TEXT NOT NULL DEFAULT 'USD',
  description TEXT,
  condition TEXT,
  condition_custom TEXT,
  provenance TEXT,
  category_attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  location TEXT,
  notes TEXT,

  -- Terms
  inspection_period_hours INTEGER DEFAULT 72, -- buyer inspection window after delivery
  release_conditions TEXT,                    -- free-text conditions for release
  sold_as_is BOOLEAN DEFAULT FALSE,
  no_warranty BOOLEAN DEFAULT FALSE,

  -- Optional on-chain settlement binding (the frozen VX Pay escrow contracts).
  -- Null for off-chain agreements; populated if the deal is settled on-chain.
  onchain_chain_id BIGINT,
  onchain_vault_address TEXT,
  onchain_transaction_id TEXT,                -- bytes32 hex, links to the escrow vault

  -- Proof package (identical shape to transfers)
  agreement_hash TEXT,                        -- sha256 of canonical agreement JSON
  rac_chain_hash TEXT,                        -- identity:scope:vxpay:timestamp chain
  veridex_signature TEXT,
  sealed_at TIMESTAMPTZ,

  -- Lifecycle: escrow-specific states layered on the seal
  status TEXT NOT NULL DEFAULT 'pending',
    -- pending | sealed | funded | delivered | acknowledged | released | refunded | disputed
  is_valid BOOLEAN DEFAULT FALSE,             -- true once sealed

  -- Funding (buyer confirms funds placed — Stripe ref or on-chain tx)
  funded_at TIMESTAMPTZ,
  funding_ref TEXT,                           -- stripe payment ref or on-chain tx hash

  -- Delivery (seller marks delivered)
  delivered_at TIMESTAMPTZ,
  delivery_note TEXT,

  -- Acknowledgement (buyer accepts -> triggers release)
  buyer_acknowledged BOOLEAN DEFAULT FALSE,
  buyer_acknowledged_at TIMESTAMPTZ,
  buyer_acknowledgement_hash TEXT,
  buyer_ack_ip TEXT,

  -- Release / settlement
  released_at TIMESTAMPTZ,
  release_ref TEXT,

  payment_ref TEXT,                           -- plan/single-agreement billing ref
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vxpay_user_id ON vxpay_agreements (user_id);
CREATE INDEX IF NOT EXISTS idx_vxpay_buyer_email ON vxpay_agreements (buyer_email);
CREATE INDEX IF NOT EXISTS idx_vxpay_seller_email ON vxpay_agreements (seller_email);
CREATE INDEX IF NOT EXISTS idx_vxpay_status ON vxpay_agreements (status);
CREATE INDEX IF NOT EXISTS idx_vxpay_created_at ON vxpay_agreements (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vxpay_onchain_txid ON vxpay_agreements (onchain_transaction_id);

-- Evidence files (mirrors transfer_evidence)
CREATE TABLE IF NOT EXISTS vxpay_evidence (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  agreement_id TEXT NOT NULL REFERENCES vxpay_agreements(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_hash TEXT NOT NULL,                    -- sha256 hex, computed client-side
  file_mime_type TEXT,
  file_size_bytes BIGINT,
  file_size TEXT,
  storage_path TEXT NOT NULL,                 -- path in vxpay-evidence bucket
  phase TEXT NOT NULL DEFAULT 'agreement',    -- agreement | delivery | dispute
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sort_order INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_vxpay_evidence_agreement ON vxpay_evidence (agreement_id);

-- updated_at trigger (mirror transfers)
CREATE OR REPLACE FUNCTION vxpay_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vxpay_updated_at ON vxpay_agreements;
CREATE TRIGGER trg_vxpay_updated_at BEFORE UPDATE ON vxpay_agreements
  FOR EACH ROW EXECUTE FUNCTION vxpay_set_updated_at();

-- Private evidence bucket (idempotent)
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('vxpay-evidence', 'vxpay-evidence', false, 104857600)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 104857600;
