// netlify/functions/get-proofs.js
// Production-grade: authenticated endpoint returning user's proof history from Supabase

exports.handler = async (event ) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS' ) {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Cookie'
      }
    };
  }

  if (event.httpMethod !== 'GET' ) {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('Supabase credentials not configured');
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Service unavailable' })
    };
  }

  try {
    // Parse session token from cookie
    const cookieHeader = event.headers.cookie || '';
    const sessionToken = parseCookie(cookieHeader, 'vxsent_session');

    if (!sessionToken) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Not authenticated' })
      };
    }

    // Validate session — look up user by session token
    const userRes = await fetch(
      `${supabaseUrl}/rest/v1/users?session_token=eq.${encodeURIComponent(sessionToken)}&limit=1`,
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
      console.error('get-proofs: user lookup failed', await userRes.text());
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Service unavailable' })
      };
    }

    const users = await userRes.json();

    if (!users || users.length === 0) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid session' })
      };
    }

    const user = users[0];

    // Check session expiry
    if (user.session_expires_at && new Date(user.session_expires_at) < new Date()) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Session expired' })
      };
    }

    // Query proofs for this user (by email, since proofs store user_email/sender_email)
    const userEmail = user.email;
    
    // Fetch proofs where sender_email or user_email matches, ordered by newest first
    const proofsRes = await fetch(
      `${supabaseUrl}/rest/v1/proofs?or=(sender_email.eq.${encodeURIComponent(userEmail)},user_email.eq.${encodeURIComponent(userEmail)})&status=eq.sealed&order=sealed_at.desc.nullsfirst,timestamp.desc&limit=50`,
      {
        method: 'GET',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!proofsRes.ok) {
      const errText = await proofsRes.text();
      console.error(`get-proofs: Supabase query failed: ${proofsRes.status} ${errText}`);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Failed to retrieve proofs' })
      };
    }

    const proofs = await proofsRes.json();

    // Calculate stats
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const totalProofs = proofs.length;
    const monthProofs = proofs.filter(p => {
      const sealDate = new Date(p.sealed_at || p.timestamp);
      return sealDate >= startOfMonth;
    }).length;

    // Calculate total value protected (sum of amounts from project metadata)
    // For now, count proofs as value indicator
    const disputesWon = proofs.filter(p => p.dispute_status === 'won').length;

    // Format proofs for frontend — include RAC chain fields
    const formattedProofs = proofs.map(p => ({
      proofId: p.proof_id,
      fileName: p.file_name,
      fileSize: p.file_size,
      fileHash: p.file_hash ? `${p.file_hash.substring(0, 8)}...${p.file_hash.substring(p.file_hash.length - 4)}` : '',
      fileHashFull: p.file_hash || '',
      sealedAt: p.sealed_at || p.timestamp,
      status: p.status,
      projectName: p.project_name || '',
      recipientEmail: p.recipient_email || '',
      // RAC chain fields
      ed25519Signature: p.ed25519_signature ? `${p.ed25519_signature.substring(0, 12)}...` : '',
      chainHash: p.chain_hash ? `${p.chain_hash.substring(0, 12)}...` : '',
      previousProofId: p.previous_proof_id || null,
      racVersion: p.rac_version || 'SENT.RAC.V1',
      isValid: p.is_valid !== false,
      receiptUrl: `https://vxsent.com/receipt?id=${p.proof_id}`,
      verifyUrl: `https://vxsent.com/receipt?id=${p.proof_id}`
    } ));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stats: {
          totalProofs,
          monthProofs,
          disputesWon,
          valueProtected: '$0' // Will be populated when payment amounts are tracked
        },
        proofs: formattedProofs
      })
    };
  } catch (error) {
    console.error('get-proofs error:', error.message, error.stack);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to load proofs' })
    };
  }
};

// Parse a specific cookie value from the Cookie header
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
