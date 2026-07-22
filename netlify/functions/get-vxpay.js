// netlify/functions/get-vxpay.js
// Public read of a VX Pay agreement for the verification page. Returns the
// sealed proof fields + lifecycle. Mirrors get-transfer.js.

import { getDb, CORS_HEADERS } from './_vxpay-common.js';

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  const id = (event.queryStringParameters && event.queryStringParameters.id) || '';
  if (!id) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing id' }) };
  try {
    const db = getDb();
    const rows = await db.sql`SELECT * FROM vxpay_agreements WHERE id = ${id}`;
    const a = rows[0];
    if (!a) return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
    const evidence = await db.sql`
      SELECT file_name, file_hash, file_size, phase, uploaded_at
      FROM vxpay_evidence WHERE agreement_id = ${id} ORDER BY sort_order`;
    // never expose internal user_id / ips to the public verify surface
    const { user_id, buyer_ack_ip, ...pub } = a;
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ agreement: pub, evidence: evidence || [] }) };
  } catch (err) {
    console.error('[get-vxpay]', err);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
}
