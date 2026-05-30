// netlify/functions/_transfer-finalize-helper.js
// Shared finalization logic for SENT Transfer (Verified Bill of Sale).
// Mirrors _proof-finalize-helper.js exactly: real SHA-256 RAC chain + placeholder
// Ed25519 signature (same TBD marker as the proof system, so both swap to real
// Veridex signing at the same time).
//
// CRITICAL: single source of truth for transfer RAC chain writing.

import { createHash, randomBytes } from 'crypto';
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

function sha256(str) { return createHash('sha256').update(str).digest('hex'); }

// Humanized labels for the per-category attribute bag, mirrored from the verify
// and acknowledgment pages so the emails surface the same sealed details
// (VIN, odometer, title status, HIN, engine hours, …). Additive: any category's
// attributes render the same way; unknown keys are humanized.
const ATTR_EMAIL_LABELS = {
  size: 'Size', sku: 'Style / SKU', authentication: 'Authentication',
  metal: 'Metal', stones: 'Stones', appraisal_cert: 'Appraisal / Certificate',
  serial: 'Serial number', imei: 'IMEI',
  vin: 'VIN', odometer: 'Odometer reading (mi)', year_make_model: 'Year / Make / Model', title_status: 'Title status',
  hin: 'HIN (Hull ID)', engine_hours: 'Engine hours', trailer_included: 'Trailer included', registration_status: 'Registration status'
};
function escEmail(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function attrEmailRows(attrs) {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return '';
  return Object.keys(attrs)
    .filter(k => attrs[k] != null && String(attrs[k]).trim() !== '')
    .map(k => {
      const label = ATTR_EMAIL_LABELS[k] || k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      return `<tr style="border-bottom:1px solid #e1e4e8"><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280">${escEmail(label)}</td><td style="padding:10px 0;font-size:12px;color:#111318">${escEmail(attrs[k])}</td></tr>`;
    }).join('');
}

// Real Veridex signing — mirrors stripe-webhook.js callVeridex().
// Calls /v1/guardedCommit when configured; falls back to deterministic SHA-256
// signature when Veridex env vars are absent (same behavior as the webhook).
async function callVeridex({ transferId, agreementHash, chainHash, timestamp }) {
  const veridexUrl = process.env.VERIDEX_API_URL;
  const veridexKey = process.env.VERIDEX_API_KEY;

  if (!veridexUrl || !veridexKey) {
    const fallbackSig = sha256(`${transferId}:${agreementHash}:${timestamp}`);
    return { signature: fallbackSig, algorithm: 'SHA-256-fallback' };
  }

  try {
    const response = await fetch(`${veridexUrl}/v1/guardedCommit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${veridexKey}`,
        'X-Idempotency-Key': transferId,
        'X-RAC-Version': '1.0'
      },
      body: JSON.stringify({
        action: 'seal_transfer',
        transfer_id: transferId,
        agreement_hash: agreementHash,
        rac_chain_hash: chainHash,
        timestamp
      })
    });
    if (!response.ok) throw new Error(`Veridex ${response.status}: ${await response.text()}`);
    const result = await response.json();
    return { signature: result.signature, algorithm: result.algorithm || 'Ed25519' };
  } catch (err) {
    console.error('[_transfer-finalize-helper] Veridex failed, using fallback:', err.message);
    const fallbackSig = sha256(`${transferId}:${agreementHash}:${timestamp}`);
    return { signature: fallbackSig, algorithm: 'SHA-256-fallback' };
  }
}

// Deterministic, key-sorted view of the per-category adapter bag so the same
// attributes always hash identically (insertion order can't change the seal).
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

// Canonical agreement hash: deterministic JSON of the agreed terms.
// Any later change to terms produces a different hash → tamper-evident.
// Provenance and the per-category attributes are first-class and sealed in.
export function buildAgreementHash(transfer, evidenceHashes) {
  const canonical = JSON.stringify({
    seller: { name: transfer.seller_name, email: transfer.seller_email },
    buyer: { name: transfer.buyer_name, email: transfer.buyer_email },
    item: {
      title: transfer.item_title,
      category: transfer.category || '',
      price: transfer.sale_price != null ? String(transfer.sale_price) : '',
      date: transfer.transfer_date || '',
      description: transfer.description || '',
      condition: transfer.condition || '',
      condition_custom: transfer.condition_custom || '',
      provenance: transfer.provenance || '',
      attributes: canonicalAttributes(transfer.category_attributes),
      location: transfer.location || '',
      notes: transfer.notes || ''
    },
    disclosures: {
      defects: transfer.disclosed_defects || '',
      damage: transfer.disclosed_damage || '',
      missing_parts: transfer.disclosed_missing_parts || '',
      repairs: transfer.disclosed_repairs || '',
      special: transfer.disclosed_special_conditions || ''
    },
    toggles: {
      sold_as_is: !!transfer.sold_as_is,
      no_warranty: !!transfer.no_warranty,
      buyer_inspected: !!transfer.buyer_inspected,
      inspection_completed: !!transfer.inspection_completed,
      buyer_acknowledged_condition: !!transfer.buyer_acknowledged_condition
    },
    evidence: (evidenceHashes || []).slice().sort()  // sorted so order doesn't change hash
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// RAC chain — same shape as the proof system:
// identity(seller+id) -> scope(buyer:agreementHash) -> chain(identity:scope:transfer:timestamp)
export function buildTransferChainHash({ transferId, sellerEmail, buyerEmail, agreementHash, timestamp }) {
  const identityHash = createHash('sha256').update(sellerEmail + transferId).digest('hex');
  const scopeHash = createHash('sha256').update(`${buyerEmail}:${agreementHash}`).digest('hex');
  const chainHash = createHash('sha256').update(`${identityHash}:${scopeHash}:transfer:${timestamp}`).digest('hex');
  return chainHash;
}

async function sendSellerReceipt({ transfer, transferId, sealedAt, verifyUrl }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SENT. <receipts@vxsent.com>',
      to: transfer.seller_email,
      subject: `Verified Transfer sealed — ${transfer.item_title}`,
      html: `<div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;background:#f5f6f8">
        <div style="background:#00b356;color:#fff;padding:14px 28px;border-radius:8px 8px 0 0"><div style="font-family:'Bebas Neue',sans-serif;font-size:20px;letter-spacing:0.1em">\u2713 TRANSFER SEALED</div></div>
        <div style="background:#fff;border:1px solid #e1e4e8;border-top:none;border-radius:0 0 8px 8px;padding:32px">
          <h2 style="font-family:'Bebas Neue',sans-serif;font-size:26px;color:#111318;margin-bottom:8px">PROOF CREATED. AWAITING ACKNOWLEDGMENT.</h2>
          <p style="font-size:13px;color:#374151;line-height:1.65;margin-bottom:20px">Your verified transfer is sealed and timestamped. <strong>${transfer.buyer_name}</strong> has been sent a secure link to review and acknowledge.</p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
            <tr style="border-bottom:1px solid #e1e4e8"><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280;width:120px">Transfer ID</td><td style="padding:10px 0;font-size:11px;color:#111318;font-family:monospace">${transferId}</td></tr>
            <tr style="border-bottom:1px solid #e1e4e8"><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280">Item</td><td style="padding:10px 0;font-size:12px;color:#111318">${transfer.item_title}</td></tr>
            ${attrEmailRows(transfer.category_attributes)}
            <tr style="border-bottom:1px solid #e1e4e8"><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280">Buyer</td><td style="padding:10px 0;font-size:12px;color:#111318">${transfer.buyer_name}</td></tr>
            <tr><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280">Sealed</td><td style="padding:10px 0;font-size:11px;color:#00b356;font-weight:bold">${new Date(sealedAt).toUTCString()}</td></tr>
          </table>
          <a href="${verifyUrl}" style="display:inline-block;padding:14px 28px;background:#00b356;color:#fff;text-decoration:none;font-family:'Bebas Neue',sans-serif;font-size:18px;letter-spacing:0.1em;border-radius:4px">VIEW TRANSFER \u2192</a>
        </div>
        <p style="font-size:10px;color:#9ca3af;text-align:center;margin-top:16px;font-family:monospace;text-transform:uppercase;letter-spacing:0.1em">SENT. \u2014 Verified Transfer Infrastructure \u00b7 vxsent.com</p>
      </div>`
    })
  });
}

async function sendBuyerAcknowledgmentRequest({ transfer, transferId, sealedAt, ackUrl }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SENT. <receipts@vxsent.com>',
      to: transfer.buyer_email,
      subject: `${transfer.seller_name} sent you a Verified Transfer \u2014 review & acknowledge`,
      html: `<div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;background:#f5f6f8">
        <div style="background:#fff;border:1px solid #e1e4e8;border-radius:8px;padding:32px;border-top:3px solid #00b356">
          <h2 style="font-size:20px;color:#111318;margin-bottom:12px">You have a Verified Transfer.</h2>
          <p style="font-size:14px;color:#374151;line-height:1.65;margin-bottom:24px"><strong>${transfer.seller_name}</strong> has sent you a verified record of a sale. Please review the condition, photos, and disclosures, then acknowledge. Your acknowledgment is cryptographically sealed and protects both parties.</p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
            <tr style="border-bottom:1px solid #e1e4e8"><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280;width:100px">Item</td><td style="padding:10px 0;font-size:13px;color:#111318">${transfer.item_title}</td></tr>
            ${attrEmailRows(transfer.category_attributes)}
            <tr style="border-bottom:1px solid #e1e4e8"><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280">Price</td><td style="padding:10px 0;font-size:13px;color:#111318">${transfer.sale_price != null ? '$' + transfer.sale_price : '\u2014'}</td></tr>
            <tr><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280">Transfer ID</td><td style="padding:10px 0;font-size:11px;color:#111318;font-family:monospace">${transferId}</td></tr>
          </table>
          <a href="${ackUrl}" style="display:inline-block;padding:14px 28px;background:#00b356;color:#fff;text-decoration:none;font-family:'Bebas Neue',sans-serif;font-size:18px;letter-spacing:0.1em;border-radius:4px">REVIEW & ACKNOWLEDGE \u2192</a>
          <p style="font-size:11px;color:#6b7280;margin-top:16px;line-height:1.5">This protects you too \u2014 it's an independent record of exactly what was agreed, created before any dispute.</p>
        </div>
        <p style="font-size:10px;color:#9ca3af;text-align:center;margin-top:16px;font-family:monospace;text-transform:uppercase;letter-spacing:0.1em">SENT. \u2014 Verified Transfer Infrastructure \u00b7 vxsent.com</p>
      </div>`
    })
  });
}

/**
 * Seal a transfer: compute agreement hash + RAC chain, write signature, mark valid, email both parties.
 * @returns { agreementHash, chainHash, veridexSignature }
 */
export async function finalizeTransfer({ transferId, sealedAt }) {
  const supabase = getSupabase();

  // Load transfer + evidence
  const { data: transfer, error: tErr } = await supabase
    .from('transfers').select('*').eq('id', transferId).maybeSingle();
  if (tErr || !transfer) throw new Error('Transfer not found for finalize');

  const { data: evidence } = await supabase
    .from('transfer_evidence').select('file_hash').eq('transfer_id', transferId);
  const evidenceHashes = (evidence || []).map(e => e.file_hash);

  const ts = sealedAt || new Date().toISOString();
  const agreementHash = buildAgreementHash(transfer, evidenceHashes);
  const chainHash = buildTransferChainHash({
    transferId,
    sellerEmail: transfer.seller_email,
    buyerEmail: transfer.buyer_email,
    agreementHash,
    timestamp: ts
  });
  const veridexResult = await callVeridex({ transferId, agreementHash, chainHash, timestamp: ts });
  const veridexSignature = veridexResult.signature;

  const { error: upErr } = await supabase.from('transfers').update({
    agreement_hash: agreementHash,
    rac_chain_hash: chainHash,
    veridex_signature: veridexSignature,
    sealed_at: ts,
    is_valid: true,
    status: 'sealed'
  }).eq('id', transferId);
  if (upErr) throw new Error(`Failed to seal transfer: ${upErr.message}`);

  const baseUrl = process.env.URL || 'https://vxsent.com';
  const verifyUrl = `${baseUrl}/verify/${transferId}`;
  const ackUrl = `${baseUrl}/transfer-ack?id=${transferId}`;

  try {
    await sendSellerReceipt({ transfer, transferId, sealedAt: ts, verifyUrl });
    await sendBuyerAcknowledgmentRequest({ transfer, transferId, sealedAt: ts, ackUrl });
  } catch (e) {
    console.error('[_transfer-finalize-helper] email failed (non-fatal):', e.message);
  }

  return { agreementHash, chainHash, veridexSignature };
}
