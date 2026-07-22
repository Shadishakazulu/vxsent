// netlify/functions/_vxpay-finalize-helper.js
// Shared finalization logic for VX Pay (Escrowed Payment Agreement).
// Mirrors _transfer-finalize-helper.js EXACTLY: canonical agreement hash +
// SHA-256 RAC chain + Veridex signature (Ed25519 when configured, SHA-256
// fallback otherwise). VX Pay therefore shares the SAME proof engine as SENT
// and Transfer and verifies through the same /verify/:id surface.
//
// CRITICAL: single source of truth for VX Pay RAC chain writing.
// Agreement rows are persisted to the Netlify Database.

import { createHash } from 'crypto';
import { getDb } from './_vxpay-common.js';

function sha256(str) { return createHash('sha256').update(str).digest('hex'); }

// Real Veridex signing — mirrors _transfer-finalize-helper.js callVeridex().
// Falls back to deterministic SHA-256 when Veridex env vars are absent.
async function callVeridex({ agreementId, agreementHash, chainHash, timestamp }) {
  const veridexUrl = process.env.VERIDEX_API_URL;
  const veridexKey = process.env.VERIDEX_API_KEY;

  if (!veridexUrl || !veridexKey) {
    const fallbackSig = sha256(`${agreementId}:${agreementHash}:${timestamp}`);
    return { signature: fallbackSig, algorithm: 'SHA-256-fallback' };
  }
  try {
    const response = await fetch(`${veridexUrl}/v1/guardedCommit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${veridexKey}`,
        'X-Idempotency-Key': agreementId,
        'X-RAC-Version': '1.0'
      },
      body: JSON.stringify({
        action: 'seal_vxpay',
        agreement_id: agreementId,
        agreement_hash: agreementHash,
        rac_chain_hash: chainHash,
        timestamp
      })
    });
    if (!response.ok) throw new Error(`Veridex ${response.status}: ${await response.text()}`);
    const result = await response.json();
    return { signature: result.signature, algorithm: result.algorithm || 'Ed25519' };
  } catch (err) {
    console.error('[_vxpay-finalize-helper] Veridex failed, using fallback:', err.message);
    const fallbackSig = sha256(`${agreementId}:${agreementHash}:${timestamp}`);
    return { signature: fallbackSig, algorithm: 'SHA-256-fallback' };
  }
}

// Deterministic, key-sorted attributes (mirrors transfer helper).
export function canonicalAttributes(attrs) {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return {};
  const out = {};
  for (const k of Object.keys(attrs).sort()) {
    const v = attrs[k];
    if (v === null || v === undefined || v === '') continue;
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

// Canonical agreement hash for an escrow agreement. Tamper-evident: any change
// to the agreed terms (amount, parties, item, release conditions, evidence)
// yields a different hash. Same construction style as the transfer helper.
export function buildAgreementHash(a, evidenceHashes) {
  const canonical = JSON.stringify({
    kind: 'vxpay_escrow',
    buyer: { name: a.buyer_name, email: a.buyer_email },
    seller: { name: a.seller_name, email: a.seller_email },
    item: {
      title: a.item_title,
      category: a.category || '',
      amount: a.amount != null ? String(a.amount) : '',
      currency: a.currency || 'USD',
      description: a.description || '',
      condition: a.condition || '',
      condition_custom: a.condition_custom || '',
      provenance: a.provenance || '',
      attributes: canonicalAttributes(a.category_attributes),
      location: a.location || '',
      notes: a.notes || ''
    },
    terms: {
      inspection_period_hours: a.inspection_period_hours != null ? String(a.inspection_period_hours) : '',
      release_conditions: a.release_conditions || '',
      sold_as_is: !!a.sold_as_is,
      no_warranty: !!a.no_warranty
    },
    onchain: {
      chain_id: a.onchain_chain_id != null ? String(a.onchain_chain_id) : '',
      vault_address: a.onchain_vault_address || '',
      transaction_id: a.onchain_transaction_id || ''
    },
    evidence: (evidenceHashes || []).slice().sort()
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// RAC chain — identical shape to the proof/transfer systems, domain-tagged 'vxpay':
// identity(buyer+id) -> scope(seller:agreementHash) -> chain(identity:scope:vxpay:timestamp)
export function buildVxpayChainHash({ agreementId, buyerEmail, sellerEmail, agreementHash, timestamp }) {
  const identityHash = createHash('sha256').update(buyerEmail + agreementId).digest('hex');
  const scopeHash = createHash('sha256').update(`${sellerEmail}:${agreementHash}`).digest('hex');
  const chainHash = createHash('sha256').update(`${identityHash}:${scopeHash}:vxpay:${timestamp}`).digest('hex');
  return chainHash;
}

/**
 * Seal a VX Pay agreement: compute agreement hash + RAC chain, write signature,
 * mark valid. Returns { agreementHash, chainHash, veridexSignature, algorithm }.
 */
export async function finalizeVxpay({ agreementId, sealedAt }) {
  const db = getDb();
  const agreements = await db.sql`SELECT * FROM vxpay_agreements WHERE id = ${agreementId}`;
  const agreement = agreements[0];
  if (!agreement) throw new Error('VX Pay agreement not found for finalize');

  const evidence = await db.sql`SELECT file_hash FROM vxpay_evidence WHERE agreement_id = ${agreementId}`;
  const evidenceHashes = (evidence || []).map(e => e.file_hash);

  const ts = sealedAt || new Date().toISOString();
  const agreementHash = buildAgreementHash(agreement, evidenceHashes);
  const chainHash = buildVxpayChainHash({
    agreementId, buyerEmail: agreement.buyer_email, sellerEmail: agreement.seller_email,
    agreementHash, timestamp: ts
  });
  const veridexResult = await callVeridex({ agreementId, agreementHash, chainHash, timestamp: ts });

  await db.sql`
    UPDATE vxpay_agreements SET
      agreement_hash = ${agreementHash},
      rac_chain_hash = ${chainHash},
      veridex_signature = ${veridexResult.signature},
      sealed_at = ${ts},
      is_valid = ${true},
      status = ${'sealed'}
    WHERE id = ${agreementId}
  `;

  return { agreementHash, chainHash, veridexSignature: veridexResult.signature, algorithm: veridexResult.algorithm };
}
