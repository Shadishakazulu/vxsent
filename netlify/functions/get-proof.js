// netlify/functions/get-proof.js
// SENT. RAC v1 — Public proof retrieval endpoint
// Returns ALL cryptographic data for independent verification
// No authentication required — proofs are public records

exports.handler = async (event ) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS' ) {
    return { statusCode: 200, headers };
  }

  if (event.httpMethod !== 'GET' ) {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    // ─── Validate environment ───────────────────────────────────────────────
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.error('[FATAL] Supabase credentials not configured');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Service unavailable' }) };
    }

    // ─── Parse proof ID from query string ───────────────────────────────────
    const proofId = event.queryStringParameters?.id;

    if (!proofId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing proof ID. Usage: ?id=SENT-YYYY-XXXXXXXX-XXXX-XXXX-XXXX' }) };
    }

    // Validate proof ID format
    if (!/^SENT-\d{4}-[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/i.test(proofId)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid proof ID format' }) };
    }

    // ─── Query Supabase ─────────────────────────────────────────────────────
    const response = await fetch(
      `${supabaseUrl}/rest/v1/proofs?proof_id=eq.${encodeURIComponent(proofId)}&select=*&limit=1`,
      {
        method: 'GET',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[RAC] Supabase query failed: ${response.status} ${errText}`);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to retrieve proof' }) };
    }

    const proofs = await response.json();

    if (!proofs || proofs.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Proof not found', proofId }) };
    }

    const proof = proofs[0];

    // ─── Build public response ──────────────────────────────────────────────
    // Include ALL fields needed for independent verification
    const publicProof = {
      // Identity
      proofId: proof.proof_id,
      status: proof.status,
      isValid: proof.is_valid,
      racVersion: proof.rac_version || 'SENT.RAC.V1',

      // File metadata
      fileName: proof.file_name,
      fileSize: proof.file_size,
      fileHash: proof.file_hash,

      // Timestamps
      timestamp: proof.timestamp,
      sealedAt: proof.sealed_at,
      verifiedAt: proof.verified_at,

      // Cryptographic proof (Ed25519)
      ed25519Signature: proof.ed25519_signature,
      ed25519PublicKey: proof.ed25519_public_key,

      // RAC Chain
      chainHash: proof.chain_hash,
      previousProofId: proof.previous_proof_id,

      // Parties (public — these are on the receipt)
      senderEmail: proof.sender_email ? maskEmail(proof.sender_email) : null,
      recipientEmail: proof.recipient_email ? maskEmail(proof.recipient_email) : null,
      projectName: proof.project_name,

      // Verification helpers
      canonicalPayload: proof.sealed_at
        ? `SENT.PROOF.V1|${proof.proof_id}|${proof.file_hash}|${proof.file_name}|${proof.file_size}|${proof.sealed_at}`
        : null,
      receiptUrl: `https://vxsent.com/receipt?id=${proof.proof_id}`,

      // Verification instructions
      verification: {
        algorithm: 'Ed25519',
        payloadFormat: 'SENT.PROOF.V1|{proof_id}|{file_hash}|{file_name}|{file_size}|{sealed_at}',
        chainFormat: 'SHA-256(previous_chain_hash + current_signature )',
        genesisFormat: 'SHA-256(GENESIS|current_signature)',
        instructions: [
          '1. Reconstruct canonical payload using the format above',
          '2. Verify Ed25519 signature against the public key',
          '3. Verify chain hash: SHA-256(previous_chain_hash + signature)',
          '4. For genesis proofs (no previousProofId): SHA-256(GENESIS|signature)'
        ]
      }
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(publicProof)
    };

  } catch (error) {
    console.error('[RAC] get-proof error:', error.message, error.stack);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to retrieve proof' })
    };
  }
};

// ─── Helpers ────────────────────────────────────────────────────────────────────

function maskEmail(email) {
  if (!email || !email.includes('@')) return email;
  const [local, domain] = email.split('@');
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local[0]}${local[1]}***@${domain}`;
}
