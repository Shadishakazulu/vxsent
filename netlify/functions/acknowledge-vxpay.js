// netlify/functions/acknowledge-vxpay.js — buyer acknowledges delivery.
// Writes a tamper-evident acknowledgement hash and releases the escrow.
// Mirrors acknowledge-transfer.js (buyer confirmation hash + ip).
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}
function getSessionToken(event) {
  const cookie = event.headers.cookie || event.headers.Cookie || '';
  const m1 = cookie.match(/vxsent_session=([^;]+)/); if (m1) return m1[1];
  const m2 = cookie.match(/session_token=([^;]+)/); if (m2) return m2[1];
  return null;
}
async function verifySession(event) {
  const token = getSessionToken(event); if (!token) return null;
  const supabase = getSupabase(); const now = new Date().toISOString();
  let { data: user } = await supabase.from('users').select('id, email').eq('session_token', token).gt('session_expires_at', now).single();
  if (user) return user;
  const { data: user2 } = await supabase.from('users').select('id, email').eq('magic_token', token).gt('magic_token_expires', now).single();
  return user2 || null;
}
const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cookie',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Credentials': 'true'
};
export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  try {
    const { id } = JSON.parse(event.body || '{}');
    if (!id) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing id' }) };
    const supabase = getSupabase();
    const { data: a } = await supabase.from('vxpay_agreements').select('*').eq('id', id).maybeSingle();
    if (!a) return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
    if (a.status !== 'delivered') return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: `Cannot acknowledge from status '${a.status}'` }) };
    const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;
    const ts = new Date().toISOString();
    // acknowledgement hash binds the sealed agreement + ack time (tamper-evident)
    const ackHash = createHash('sha256').update(`${a.rac_chain_hash}:acknowledged:${ts}`).digest('hex');
    const { error } = await supabase.from('vxpay_agreements').update({
      status: 'released',
      buyer_acknowledged: true, buyer_acknowledged_at: ts,
      buyer_acknowledgement_hash: ackHash, buyer_ack_ip: ip,
      released_at: ts
    }).eq('id', id);
    if (error) throw new Error(error.message);
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ id, status: 'released', acknowledgement_hash: ackHash }) };
  } catch (err) { console.error('[acknowledge-vxpay]', err); return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) }; }
}
