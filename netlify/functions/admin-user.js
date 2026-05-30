// netlify/functions/admin-user.js
// Per-user drill-down. Given ?email=, returns the matching registered user, every
// transfer that email is a party to (seller or buyer), and every sealed proof it
// is a party to (sender or recipient), each with its status — so a reseller's
// "it didn't work" can be traced to the exact record.
//
// Read-only. No sensitive values (session/magic tokens, Stripe identifiers,
// payment credentials) are selected or returned.

const { requireAdmin } = require('./_admin-auth');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Cookie' } };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const gate = await requireAdmin(event);
  if (!gate.ok) return gate.response;
  const supabase = gate.supabase;

  const rawEmail = (event.queryStringParameters && event.queryStringParameters.email) || '';
  const email = rawEmail.trim().toLowerCase();
  // Validate shape AND reject characters that would alter a PostgREST `.or()`
  // filter string (comma / parentheses), since the email is interpolated below.
  if (!email || !/^[^\s@,()]+@[^\s@,()]+\.[^\s@,()]+$/.test(email)) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Valid email required' }) };
  }

  try {
    const now = new Date();

    // Registered user (safe columns only).
    const { data: users } = await supabase
      .from('users')
      .select('id, email, plan, plan_expires_at, created_at')
      .ilike('email', email)
      .limit(1);
    const u = users && users[0];
    let user = null;
    if (u) {
      const expiresAt = u.plan_expires_at ? new Date(u.plan_expires_at) : null;
      const soloActive = u.plan === 'solo' && expiresAt && expiresAt > now;
      user = {
        email: u.email,
        plan: u.plan || 'none',
        planStatus: soloActive ? 'Solo · active' : (u.plan === 'solo' ? 'Solo · expired' : 'Pay-per-use'),
        planExpiresAt: u.plan_expires_at || null,
        createdAt: u.created_at
      };
    }

    // Transfers this email is a party to, as seller OR buyer.
    const { data: transfers } = await supabase
      .from('transfers')
      .select('id, item_title, category, seller_email, buyer_email, status, is_valid, buyer_confirmed, sealed_at, created_at')
      .or(`seller_email.eq.${email},buyer_email.eq.${email}`)
      .order('created_at', { ascending: false })
      .limit(500);

    const transferList = (transfers || []).map(t => ({
      id: t.id,
      itemTitle: t.item_title || '(untitled)',
      category: t.category || 'general',
      role: (t.seller_email || '').toLowerCase() === email ? 'seller' : 'buyer',
      counterparty: (t.seller_email || '').toLowerCase() === email ? (t.buyer_email || '') : (t.seller_email || ''),
      status: t.buyer_confirmed ? 'acknowledged' : (t.is_valid ? 'sealed' : (t.status || 'pending')),
      createdAt: t.created_at
    }));

    // Sealed proofs this email is a party to, as sender OR recipient.
    const { data: proofs } = await supabase
      .from('proofs')
      .select('id, file_name, user_email, recipient_email, recipient_confirmed, is_valid, sealed_at, created_at')
      .eq('is_valid', true)
      .or(`user_email.eq.${email},recipient_email.eq.${email}`)
      .order('created_at', { ascending: false })
      .limit(500);

    const proofList = (proofs || []).map(p => ({
      id: p.id,
      fileName: p.file_name || '(file)',
      role: (p.user_email || '').toLowerCase() === email ? 'sender' : 'recipient',
      counterparty: (p.user_email || '').toLowerCase() === email ? (p.recipient_email || '') : (p.user_email || ''),
      status: p.recipient_confirmed ? 'acknowledged' : 'sealed',
      createdAt: p.sealed_at || p.created_at
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: email,
        registered: !!user,
        user,
        transfers: transferList,
        proofs: proofList
      })
    };
  } catch (error) {
    console.error('[admin-user] error:', error.message);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Lookup failed' }) };
  }
};
