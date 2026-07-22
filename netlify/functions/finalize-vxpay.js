// netlify/functions/finalize-vxpay.js
// Seal a VX Pay agreement: compute agreement hash + RAC chain + signature.
// Mirrors finalize-transfer.js.

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  try {
    const { id } = JSON.parse(event.body || '{}');
    if (!id) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing id' }) };
    const result = await finalizeVxpay({ agreementId: id });
    const baseUrl = process.env.URL || 'https://vxsent.com';
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({
      id, status: 'sealed',
      agreement_hash: result.agreementHash,
      rac_chain_hash: result.chainHash,
      veridex_signature: result.veridexSignature,
      algorithm: result.algorithm,
      verify_url: `${baseUrl}/verify/${id}`
    }) };
  } catch (err) {
    console.error('[finalize-vxpay]', err);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
}
