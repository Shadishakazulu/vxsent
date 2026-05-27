// netlify/functions/get-proofs.js
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
    const cookieHeader = event.headers.cookie || '';
    const sessionToken = parseCookie(cookieHeader, 'vxsent_session');

    if (!sessionToken) {
      return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Not authenticated' }) };
    }

    // Look up user by session_token
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

    const { data: users, error: userErr } = await supabase
      .from('users')
      .select('id, email, plan, plan_expires_at, session_expires_at')
      .eq('session_token', sessionToken)
      .limit(1);

    if (userErr || !users || users.length === 0) {
      return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid session' }) };
    }

    const user = users[0];
    if (user.session_expires_at && new Date(user.session_expires_at) < new Date()) {
      return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Session expired' }) };
    }

    const userEmail = user.email;

    // FIX: query by user_email, filter by is_valid=true (not status=sealed)
    const { data: proofs, error: proofsErr } = await supabase
      .from('proofs')
      .select('*')
      .eq('user_email', userEmail)
      .eq('is_valid', true)
      .order('sealed_at', { ascending: false })
      .limit(50);

    if (proofsErr) {
      console.error('[get-proofs] DB error:', JSON.stringify(proofsErr));
      return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Failed to retrieve proofs' }) };
    }

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const totalProofs = (proofs || []).length;
    const monthProofs = (proofs || []).filter(p => new Date(p.sealed_at) >= startOfMonth).length;
    const disputesWon = (proofs || []).filter(p => p.dispute_status === 'won').length;

    // FIX: use p.id not p.proof_id for receipt/verify URLs
    const formattedProofs = (proofs || []).map(p => ({
      id: p.id,
      proofId: p.id,
      fileName: p.file_name,
      fileSize: p.file_size,
      fileHash: p.file_hash ? `${p.file_hash.substring(0,8)}...${p.file_hash.substring(p.file_hash.length-4)}` : '',
      fileHashFull: p.file_hash || '',
      sealedAt: p.sealed_at,
      projectName: p.project_name || '',
      recipientEmail: p.recipient_email || '',
      racChainHash: p.rac_chain_hash || '',
      racEnabled: p.rac_enabled || false,
      isValid: p.is_valid,
      receiptUrl: `/receipt?id=${p.id}`,
      verifyUrl: `https://vxsent.com/verify/${p.id}`
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stats: { totalProofs, monthProofs, disputesWon, valueProtected: '$0' },
        proofs: formattedProofs
      })
    };

  } catch (error) {
    console.error('[get-proofs] error:', error.message);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Failed to load proofs' }) };
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
