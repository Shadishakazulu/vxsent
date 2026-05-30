// netlify/functions/finalize-transfer.js
// SENT Transfer — Phase 2: called after evidence uploads complete.
// Verifies uploads landed, then seals via the shared helper (RAC chain + signature + emails).
// Mirrors finalize-proof.js.

import { createClient } from '@supabase/supabase-js';
import { finalizeTransfer } from './_transfer-finalize-helper.js';

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
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
    .from('users').select('id, email, plan, plan_expires_at')
    .eq('session_token', token).gt('session_expires_at', now).single();
  if (user) return user;
  const { data: user2 } = await supabase
    .from('users').select('id, email, plan, plan_expires_at')
    .eq('magic_token', token).gt('magic_token_expires', now).single();
  return user2 || null;
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cookie',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Credentials': 'true'
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const user = await verifySession(event);
  if (!user) return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Authentication required' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const { transferId, uploadSuccess } = body;
  if (!transferId) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Transfer ID required' }) };

  try {
    const supabase = getSupabase();

    // Load transfer, confirm ownership
    const { data: transfer, error: tErr } = await supabase
      .from('transfers').select('*').eq('id', transferId).eq('user_id', user.id).maybeSingle();
    if (tErr || !transfer) return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Transfer not found' }) };

    if (transfer.is_valid) {
      // Already sealed — idempotent return
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ transferId, alreadySealed: true }) };
    }

    // Load evidence rows
    const { data: evidence } = await supabase
      .from('transfer_evidence').select('*').eq('transfer_id', transferId);

    if (uploadSuccess === false) {
      // Uploads failed — clean up storage + rows + transfer
      if (evidence && evidence.length) {
        const paths = evidence.map(e => e.storage_path);
        await supabase.storage.from('transfer-evidence').remove(paths);
      }
      await supabase.from('transfers').delete().eq('id', transferId); // cascades evidence rows
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Upload failed — transfer cancelled' }) };
    }

    // Verify each evidence file actually landed in storage
    if (evidence && evidence.length) {
      const { data: listed } = await supabase.storage.from('transfer-evidence').list(transferId, { limit: 100 });
      const landedNames = new Set((listed || []).map(f => f.name));
      for (const ev of evidence) {
        const baseName = ev.storage_path.split('/').pop();
        if (!landedNames.has(baseName)) {
          return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: `Evidence "${ev.file_name}" was not detected in storage. Please retry.` }) };
        }
      }
    }

    // Seal: agreement hash + RAC chain + signature + emails
    const sealedAt = new Date().toISOString();
    const { agreementHash, chainHash } = await finalizeTransfer({ transferId, sealedAt });

    const baseUrl = process.env.URL || 'https://vxsent.com';
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        transferId,
        sealedAt,
        agreementHash,
        chainHash,
        verifyUrl: `${baseUrl}/verify/${transferId}`
      })
    };

  } catch (error) {
    console.error('[finalize-transfer] error:', error.message);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: `Finalize failed: ${error.message}` }) };
  }
};
