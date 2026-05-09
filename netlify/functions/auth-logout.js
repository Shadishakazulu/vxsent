// netlify/functions/auth-logout.js
// Production-grade: clears session cookie and invalidates session in Supabase

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    };
  }

  // Accept both GET and POST for logout (GET for simple link clicks)
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    // Parse session token from cookie
    const cookieHeader = event.headers.cookie || '';
    const sessionToken = parseCookie(cookieHeader, 'vxsent_session');

    // Invalidate session in Supabase (if token exists)
    if (sessionToken && supabaseUrl && supabaseKey) {
      await fetch(
        `${supabaseUrl}/rest/v1/users?session_token=eq.${encodeURIComponent(sessionToken)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            session_token: null,
            session_expires_at: null,
            updated_at: new Date().toISOString()
          })
        }
      );
    }

    // Clear cookie and redirect to login
    const expiredCookie = 'vxsent_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT';

    return {
      statusCode: 302,
      headers: {
        'Location': '/login',
        'Set-Cookie': expiredCookie,
        'Cache-Control': 'no-store'
      }
    };
  } catch (error) {
    console.error('auth-logout error:', error.message, error.stack);
    // Even on error, clear cookie and redirect
    return {
      statusCode: 302,
      headers: {
        'Location': '/login',
        'Set-Cookie': 'vxsent_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        'Cache-Control': 'no-store'
      }
    };
  }
};

function parseCookie(cookieHeader, name) {
  const cookies = cookieHeader.split(';');
  for (const cookie of cookies) {
    const [key, ...valueParts] = cookie.trim().split('=');
    if (key === name) {
      return valueParts.join('=');
    }
  }
  return null;
}
