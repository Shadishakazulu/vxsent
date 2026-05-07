// netlify/functions/auth-session.js

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS' ) {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    };
  }

  if (event.httpMethod !== 'GET' ) {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    // Get session from cookie or auth header
    const authHeader = event.headers.authorization || '';
    const sessionCookie = event.headers.cookie || '';

    // In a real app, verify JWT token or session
    // For now, return mock session data
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        authenticated: true,
        user: {
          id: 'user_123',
          email: 'user@example.com',
          name: 'User Name'
        },
        sessionId: 'session_abc123'
      })
    };
  } catch (error) {
    console.error('auth-session error:', error);
    return {
      statusCode: 401,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ error: 'Unauthorized' })
    };
  }
};
