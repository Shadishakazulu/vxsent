// netlify/functions/auth-verify.js

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS' ) {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    };
  }

  if (event.httpMethod !== 'POST' ) {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    let body;
    try {
      body = JSON.parse(event.body);
    } catch {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid request body' })
      };
    }

    const { token } = body;

    if (!token) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Token required' })
      };
    }

    // Verify token (in real app, verify JWT)
    // For now, accept any token
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        valid: true,
        user: {
          id: 'user_123',
          email: 'user@example.com'
        }
      })
    };
  } catch (error) {
    console.error('auth-verify error:', error);
    return {
      statusCode: 401,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ error: 'Token verification failed' })
    };
  }
};
