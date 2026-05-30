// netlify/functions/get-transfers.js
// Lists the verified transfers a signed-in user has created, for the dashboard.
// Mirrors get-proofs.js (session auth via vxsent_session cookie) but keys on
// transfers.user_id (set at create time) rather than an email column.

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Cookie' } };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Service unavailable' }) };
  }

  try {
    const cookieHeader = event.headers.cookie || event.headers.Cookie || '';
    const sessionToken = parseCookie(cookieHeader, 'vxsent_session') || parseCookie(cookieHeader, 'session_token');
    if (!sessionToken) {
      return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Not authenticated' }) };
    }

    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

    const { data: users, error: userErr } = await supabase
      .from('users')
      .select('id, email, session_expires_at')
      .eq('session_token', sessionToken)
      .limit(1);

    if (userErr || !users || users.length === 0) {
      return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid session' }) };
    }

    const user = users[0];
    if (user.session_expires_at && new Date(user.session_expires_at) < new Date()) {
      return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Session expired' }) };
    }

    const { data: transfers, error: tErr } = await supabase
      .from('transfers')
      .select('id, item_title, category, sale_price, buyer_name, status, is_valid, buyer_confirmed, sealed_at, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1000);

    if (tErr) {
      console.error('[get-transfers] DB error:', JSON.stringify(tErr));
      return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Failed to retrieve transfers' }) };
    }

    const list = transfers || [];
    const total = list.length;
    const sealed = list.filter(t => t.is_valid).length;
    const acknowledged = list.filter(t => t.buyer_confirmed).length;
    const pending = list.filter(t => !t.is_valid).length;

    const formatted = list.map(t => ({
      id: t.id,
      itemTitle: t.item_title,
      category: t.category || 'general',
      salePrice: t.sale_price != null ? Number(t.sale_price) : null,
      buyerName: t.buyer_name || '',
      status: t.status,
      isValid: !!t.is_valid,
      acknowledged: !!t.buyer_confirmed,
      sealedAt: t.sealed_at,
      createdAt: t.created_at,
      verifyUrl: `/verify/${t.id}`
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stats: { total, sealed, acknowledged, pending },
        transfers: formatted
      })
    };
  } catch (error) {
    console.error('[get-transfers] error:', error.message);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Failed to load transfers' }) };
  }
};

function parseCookie(cookieHeader, name) {
  const cookies = cookieHeader.split(';');
  for (const cookie of cookies) {
    const [key, ...valueParts] = cookie.trim().split('=');
    if (key === name) return valueParts.join('=');
  }
  return null;
}
