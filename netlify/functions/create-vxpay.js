// netlify/functions/create-vxpay.js
// VX Pay — create an escrowed payment agreement (buyer or seller opens it).
// Mirrors create-transfer.js: session auth, insert, returns the new agreement id.
// Finalize (finalize-vxpay.js) seals it after evidence uploads complete.

import { randomBytes } from 'crypto';
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

function generateVxpayId() {
  const year = new Date().getFullYear();
  return `VXPAY-${year}-${randomBytes(4).toString('hex').toUpperCase()}`;
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

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const user = await verifySession(event);   // creator must be signed in
    const body = JSON.parse(event.body || '{}');

    const required = ['buyer_email', 'buyer_name', 'seller_email', 'seller_name', 'item_title', 'amount'];
    for (const f of required) {
      if (!body[f] && body[f] !== 0)
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: `Missing field: ${f}` }) };
    }

    const supabase = getSupabase();
    const id = generateVxpayId();
    const createdByRole = body.created_by_role === 'seller' ? 'seller' : 'buyer';

    const { error } = await supabase.from('vxpay_agreements').insert({
      id,
      user_id: user?.id ?? null,
      created_by_role: createdByRole,
      buyer_email: body.buyer_email, buyer_name: body.buyer_name, buyer_phone: body.buyer_phone || null,
      seller_email: body.seller_email, seller_name: body.seller_name, seller_phone: body.seller_phone || null,
      item_title: body.item_title,
      category: body.category || 'general',
      amount: body.amount,
      currency: body.currency || 'USD',
      description: body.description || null,
      condition: body.condition || null,
      condition_custom: body.condition_custom || null,
      provenance: body.provenance || null,
      category_attributes: body.category_attributes || {},
      location: body.location || null,
      notes: body.notes || null,
      inspection_period_hours: body.inspection_period_hours ?? 72,
      release_conditions: body.release_conditions || null,
      sold_as_is: !!body.sold_as_is,
      no_warranty: !!body.no_warranty,
      onchain_chain_id: body.onchain_chain_id ?? null,
      onchain_vault_address: body.onchain_vault_address || null,
      onchain_transaction_id: body.onchain_transaction_id || null,
      status: 'pending',
      payment_ref: body.payment_ref || null
    });
    if (error) throw new Error(error.message);

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ id, status: 'pending' }) };
  } catch (err) {
    console.error('[create-vxpay]', err);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
}
