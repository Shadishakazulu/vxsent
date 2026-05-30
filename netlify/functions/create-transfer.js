// netlify/functions/create-transfer.js
// SENT Transfer — Phase 1: create the transfer record + return signed upload URLs for evidence.
// Mirrors create-proof-solo.js (session auth, insert, signed upload URLs).
// Phase 2 (finalize-transfer.js) seals it after evidence uploads complete.

import { randomBytes } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { finalizeTransfer } from './_transfer-finalize-helper.js';

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

function generateTransferId() {
  const year = new Date().getFullYear();
  return `SENT-TX-${year}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

function getSessionToken(event) {
  const cookie = event.headers.cookie || event.headers.Cookie || '';
  const m1 = cookie.match(/vxsent_session=([^;]+)/);
  if (m1) return m1[1];
  const m2 = cookie.match(/session_token=([^;]+)/);
  if (m2) return m2[1];
  return null;
}

async function verifySession(event) {
  const token = getSessionToken(event);
  if (!token) return null;
  const supabase = getSupabase();
  const now = new Date().toISOString();
  let { data: user } = await supabase
    .from('users')
    .select('id, email, plan, plan_expires_at')
    .eq('session_token', token)
    .gt('session_expires_at', now)
    .single();
  if (user) return user;
  const { data: user2 } = await supabase
    .from('users')
    .select('id, email, plan, plan_expires_at')
    .eq('magic_token', token)
    .gt('magic_token_expires', now)
    .single();
  return user2 || null;
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cookie',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Credentials': 'true'
};

const MAX_FILE_SIZE = 104857600; // 100MB per evidence file
const MAX_EVIDENCE = 20;

const VALID_CONDITIONS = ['New', 'Excellent', 'Good', 'Fair', 'As-Is', 'Salvage', 'Custom'];

// Low-risk categories only. 'general' is the catch-all. Unknown values fall back to 'general'.
const VALID_CATEGORIES = ['sneakers', 'jewelry', 'electronics', 'general'];

// Build marker — bump on each deploy so the function log proves which code is live.
const BUILD = '2026-05-30-transfer-payflow';

// Lightweight category-adapter bag: accept a flat object of string-ish values,
// drop empties, cap key count and value length. Never throws.
function sanitizeAttributes(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  let n = 0;
  for (const k of Object.keys(raw)) {
    if (n >= 30) break;
    const key = String(k).slice(0, 60);
    let v = raw[k];
    if (v === null || v === undefined) continue;
    v = (typeof v === 'string' ? v : String(v)).trim().slice(0, 500);
    if (!v) continue;
    out[key] = v;
    n++;
  }
  return out;
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  // Authentication is optional. Two ways to seal a transfer:
  //   1. An active 'solo'/'pro' plan holder seals immediately (mirrors the proof gate).
  //   2. Anyone else (no plan, or a guest with no session) creates a PENDING record
  //      and pays per transfer via Stripe; the webhook seals it on payment success.
  const user = await verifySession(event); // may be null for guest single-transfer
  const now = new Date();
  const planExpiry = user && user.plan_expires_at ? new Date(user.plan_expires_at) : null;
  const hasPlan = !!user && (user.plan === 'solo' || user.plan === 'pro') && planExpiry && planExpiry > now;
  const requiresPayment = !hasPlan;

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const t = body.transfer || {};
  const evidence = Array.isArray(body.evidence) ? body.evidence : [];

  // [DEBUG] Proves in the function log that the deployed code is current and shows
  // the shape that arrived (no PII values). Mirrors the [create-proof-solo] debug line.
  console.log(`[create-transfer] [DEBUG] build=${BUILD} category=${t.category || 'none'} attrKeys=${t.category_attributes && typeof t.category_attributes === 'object' ? Object.keys(t.category_attributes).length : 0} provenance=${t.provenance ? 'yes' : 'no'} evidence=${evidence.length}`);

  // Required-field validation
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!t.seller_name) return bad('Seller name required');
  if (!t.seller_email || !emailRe.test(t.seller_email)) return bad('Valid seller email required');
  if (!t.buyer_name) return bad('Buyer name required');
  if (!t.buyer_email || !emailRe.test(t.buyer_email)) return bad('Valid buyer email required');
  if (!t.item_title) return bad('Item title required');
  if (t.condition && !VALID_CONDITIONS.includes(t.condition)) return bad('Invalid condition value');
  if (evidence.length > MAX_EVIDENCE) return bad(`Maximum ${MAX_EVIDENCE} evidence files`);

  const category = VALID_CATEGORIES.includes(t.category) ? t.category : 'general';
  const categoryAttributes = sanitizeAttributes(t.category_attributes);

  for (const ev of evidence) {
    if (!ev.fileName || !ev.fileHash || ev.fileHash.length !== 64) return bad('Each evidence file needs a name and valid SHA-256 hash');
    if (ev.fileSizeBytes && ev.fileSizeBytes > MAX_FILE_SIZE) return bad(`"${ev.fileName}" exceeds the 100MB limit`);
  }

  function bad(msg) { return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: msg }) }; }

  try {
    const supabase = getSupabase();
    const transferId = generateTransferId();

    // Insert transfer (pending until sealed)
    const record = {
      id: transferId,
      user_id: user ? user.id : null,
      seller_email: t.seller_email,
      seller_name: t.seller_name,
      seller_phone: t.seller_phone || null,
      buyer_email: t.buyer_email,
      buyer_name: t.buyer_name,
      buyer_phone: t.buyer_phone || null,
      item_title: t.item_title,
      category: category,
      sale_price: (t.sale_price !== undefined && t.sale_price !== '') ? t.sale_price : null,
      transfer_date: t.transfer_date || null,
      description: t.description || null,
      condition: t.condition || null,
      condition_custom: t.condition_custom || null,
      provenance: t.provenance || null,
      category_attributes: categoryAttributes,
      location: t.location || null,
      notes: t.notes || null,
      disclosed_defects: t.disclosed_defects || null,
      disclosed_damage: t.disclosed_damage || null,
      disclosed_missing_parts: t.disclosed_missing_parts || null,
      disclosed_repairs: t.disclosed_repairs || null,
      disclosed_special_conditions: t.disclosed_special_conditions || null,
      sold_as_is: !!t.sold_as_is,
      no_warranty: !!t.no_warranty,
      buyer_inspected: !!t.buyer_inspected,
      inspection_completed: !!t.inspection_completed,
      buyer_acknowledged_condition: !!t.buyer_acknowledged_condition,
      status: 'pending',
      is_valid: false,
      payment_ref: hasPlan ? `${user.plan}_plan` : 'single_transfer'
    };

    const { error: insErr } = await supabase.from('transfers').insert(record);
    if (insErr) {
      console.error('[create-transfer] insert error:', JSON.stringify(insErr));
      throw new Error(`DB insert failed: ${insErr.message}`);
    }

    // Insert evidence rows + generate signed upload URLs
    const uploads = [];
    for (let i = 0; i < evidence.length; i++) {
      const ev = evidence[i];
      const safeName = ev.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `${transferId}/${i}_${safeName}`;

      const { error: evErr } = await supabase.from('transfer_evidence').insert({
        transfer_id: transferId,
        file_name: ev.fileName,
        file_hash: ev.fileHash,
        file_mime_type: ev.fileMimeType || null,
        file_size_bytes: ev.fileSizeBytes || null,
        file_size: ev.fileSize || null,
        storage_path: storagePath,
        sort_order: i
      });
      if (evErr) {
        console.error('[create-transfer] evidence insert error:', JSON.stringify(evErr));
        // Roll back the whole transfer
        await supabase.from('transfers').delete().eq('id', transferId);
        throw new Error(`Evidence insert failed: ${evErr.message}`);
      }

      const { data: signed, error: urlErr } = await supabase.storage
        .from('transfer-evidence')
        .createSignedUploadUrl(storagePath);
      if (urlErr) {
        console.error('[create-transfer] signed url error:', JSON.stringify(urlErr));
        await supabase.from('transfers').delete().eq('id', transferId);
        throw new Error(`Upload URL failed: ${urlErr.message}`);
      }

      uploads.push({
        fileName: ev.fileName,
        storagePath,
        uploadUrl: signed.signedUrl,
        uploadToken: signed.token
      });
    }

    // Plan holder with no evidence → seal immediately (mirrors create-proof-solo's
    // no-file path): write the RAC chain hash now and email both parties.
    if (uploads.length === 0 && !requiresPayment) {
      const sealedAt = new Date().toISOString();
      const { agreementHash, chainHash } = await finalizeTransfer({ transferId, sealedAt });
      const baseUrl = process.env.URL || 'https://vxsent.com';
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          transferId,
          sealed: true,
          hasEvidence: false,
          sealedAt,
          agreementHash,
          chainHash,
          verifyUrl: `${baseUrl}/verify/${transferId}`
        })
      };
    }

    // Otherwise the record stays pending. Plan holders upload evidence then call
    // finalize-transfer to seal; pay-per-use sellers upload evidence (if any) then
    // pay via /api/create-transfer-payment, and the Stripe webhook seals on success.
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ transferId, uploads, hasEvidence: uploads.length > 0, requiresPayment })
    };

  } catch (error) {
    console.error('[create-transfer] error:', error.message);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: `Failed to create transfer: ${error.message}` }) };
  }
};
