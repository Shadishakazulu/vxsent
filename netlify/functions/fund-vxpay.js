// netlify/functions/fund-vxpay.js — buyer marks the escrow funded.
// Requires the agreement to be sealed. Records funding_ref + timestamp.
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
    const { id, funding_ref } = JSON.parse(event.body || '{}');
    if (!id) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing id' }) };
    const supabase = getSupabase();
    const { data: a } = await supabase.from('vxpay_agreements').select('status').eq('id', id).maybeSingle();
    if (!a) return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
    if (a.status !== 'sealed') return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: `Cannot fund from status '${a.status}'` }) };
    const { error } = await supabase.from('vxpay_agreements').update({
      status: 'funded', funded_at: new Date().toISOString(), funding_ref: funding_ref || null
    }).eq('id', id);
    if (error) throw new Error(error.message);
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ id, status: 'funded' }) };
  } catch (err) { console.error('[fund-vxpay]', err); return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) }; }
}
