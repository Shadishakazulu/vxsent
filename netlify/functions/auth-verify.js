// netlify/functions/auth-verify.js
// Production-grade: validates magic link token, sets session cookie, redirects to dashboard

const crypto = require('crypto');

exports.handler = async (event) => {
  // Magic links arrive as GET requests (user clicks link in email)
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const siteUrl = process.env.SITE_URL || 'https://vxsent.com';

  if (!supabaseUrl || !supabaseKey) {
    console.error('Supabase credentials not configured');
    return {
      statusCode: 302,
      headers: { 'Location': '/login?error=server_error' }
    };
  }

  try {
    const token = event.queryStringParameters?.token;
    const email = event.queryStringParameters?.email;

    if (!token || !email) {
      console.error('auth-verify: missing token or email');
      return {
        statusCode: 302,
        headers: { 'Location': '/login?error=invalid_link' }
      };
    }

    // Look up user by email and validate token
    const userRes = await fetch(
      `${supabaseUrl}/rest/v1/users?email=eq.${encodeURIComponent(email)}&limit=1`,
      {
        method: 'GET',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!userRes.ok) {
      console.error('auth-verify: Supabase query failed', await userRes.text());
      return {
        statusCode: 302,
        headers: { 'Location': '/login?error=server_error' }
      };
    }

    const users = await userRes.json();

    if (!users || users.length === 0) {
      console.error('auth-verify: user not found for email', email);
      return {
        statusCode: 302,
        headers: { 'Location': '/login?error=invalid_link' }
      };
    }

    const user = users[0];

    // Validate token matches
    if (user.magic_token !== token) {
      console.error('auth-verify: token mismatch');
      return {
        statusCode: 302,
        headers: { 'Location': '/login?error=invalid_token' }
      };
    }

    // Check token expiry
    if (user.token_expires_at && new Date(user.token_expires_at) < new Date()) {
      console.error('auth-verify: token expired');
      return {
        statusCode: 302,
        headers: { 'Location': '/login?error=expired_token' }
      };
    }

    // Token is valid — generate session token
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const sessionExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

    // Update user: clear magic token, set session token
    const updateRes = await fetch(
      `${supabaseUrl}/rest/v1/users?email=eq.${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          magic_token: null,
          token_expires_at: null,
          session_token: sessionToken,
          session_expires_at: sessionExpiry,
          last_login_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
      }
    );

    if (!updateRes.ok) {
      console.error('auth-verify: failed to update session', await updateRes.text());
      return {
        statusCode: 302,
        headers: { 'Location': '/login?error=server_error' }
      };
    }

    console.log(`User authenticated: ${email}`);

    // Set session cookie and redirect to dashboard
    // Cookie: HttpOnly, Secure, SameSite=Strict, 30 day expiry
    const cookieExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toUTCString();
    const cookie = `vxsent_session=${sessionToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Expires=${cookieExpiry}`;

    return {
      statusCode: 302,
      headers: {
        'Location': '/dashboard',
        'Set-Cookie': cookie,
        'Cache-Control': 'no-store'
      }
    };
  } catch (error) {
    console.error('auth-verify error:', error.message, error.stack);
    return {
      statusCode: 302,
      headers: { 'Location': '/login?error=server_error' }
    };
  }
};
