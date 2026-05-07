// netlify/functions/get-proofs.js

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
    const { email } = event.queryStringParameters || {};

    if (!email) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Email required' })
      };
    }

    // In a real app, fetch from database where user_email = email
    // For now, return mock data
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        proofs: [
          {
            proofId: 'proof_123',
            fileName: 'document.pdf',
            timestamp: new Date().toISOString(),
            status: 'valid'
          }
        ],
        count: 1
      })
    };
  } catch (error) {
    console.error('get-proofs error:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ error: 'Failed to retrieve proofs' })
    };
  }
};
