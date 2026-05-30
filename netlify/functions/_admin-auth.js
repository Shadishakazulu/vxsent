// netlify/functions/_admin-auth.js
// Shared server-side admin gate. Every admin function calls requireAdmin() before
// touching any data. It does two things, in order, entirely on the server:
//   1. Validates the vxsent_session cookie against the users table
//      (missing / invalid / expired session -> 401).
//   2. Confirms the session's email is on a hardcoded allowlist
//      (anyone else -> 403, empty body).
// There is no client-side check that can be bypassed and no secret URL — the
// data-returning functions are the security boundary, not the page.
//
// Sensitive columns (session tokens, magic-link tokens, Stripe identifiers) are
// never selected here and are never logged.

const { createClient } = require('@supabase/supabase-js');

// Hardcoded, server-side allowlist. Single operator address for launch.
const ADMIN_EMAILS = ['shadi@eyespai.com'];

function isAdminEmail(email) {
  if (!email) return false;
  return ADMIN_EMAILS.includes(String(email).trim().toLowerCase());
}

function parseCookie(cookieHeader, name) {
  const cookies = (cookieHeader || '').split(';');
  for (const cookie of cookies) {
    const [key, ...valueParts] = cookie.trim().split('=');
    if (key === name) return valueParts.join('=');
  }
  return null;
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// Returns one of:
//   { ok: true, user, supabase }
//   { ok: false, response: { statusCode, headers, body } }
// Callers should `return result.response` on failure.
async function requireAdmin(event) {
  const deny = (statusCode, body) => ({
    ok: false,
    response: {
      statusCode,
      headers: { 'Content-Type': 'application/json' },
      body: body == null ? '' : JSON.stringify(body)
    }
  });

  const supabase = getSupabase();
  if (!supabase) {
    return deny(500, { error: 'Service unavailable' });
  }

  const cookieHeader = event.headers.cookie || event.headers.Cookie || '';
  const sessionToken = parseCookie(cookieHeader, 'vxsent_session');
  if (!sessionToken) {
    return deny(401, { error: 'Not authenticated' });
  }

  let users;
  try {
    const res = await supabase
      .from('users')
      .select('id, email, plan, plan_expires_at, session_expires_at, created_at')
      .eq('session_token', sessionToken)
      .limit(1);
    if (res.error) throw res.error;
    users = res.data;
  } catch (e) {
    // Do not leak details; log only a generic marker.
    console.error('[admin-auth] session lookup failed');
    return deny(500, { error: 'Service unavailable' });
  }

  if (!users || users.length === 0) {
    return deny(401, { error: 'Invalid session' });
  }

  const user = users[0];
  if (user.session_expires_at && new Date(user.session_expires_at) < new Date()) {
    return deny(401, { error: 'Session expired' });
  }

  // Authenticated but not on the allowlist -> 403 with an empty body.
  if (!isAdminEmail(user.email)) {
    return deny(403, null);
  }

  return { ok: true, user, supabase };
}

module.exports = { requireAdmin, isAdminEmail, parseCookie, getSupabase, ADMIN_EMAILS };
