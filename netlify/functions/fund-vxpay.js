// netlify/functions/fund-vxpay.js — buyer marks the escrow funded.
// Requires the agreement to be sealed. Records funding_ref + timestamp.
import { getDb, CORS_HEADERS } from './_vxpay-common.js';

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  try {
    const { id, funding_ref } = JSON.parse(event.body || '{}');
    if (!id) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing id' }) };
    const db = getDb();
    const rows = await db.sql`SELECT status FROM vxpay_agreements WHERE id = ${id}`;
    const a = rows[0];
    if (!a) return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
    if (a.status !== 'sealed') return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: `Cannot fund from status '${a.status}'` }) };
    await db.sql`
      UPDATE vxpay_agreements
      SET status = ${'funded'}, funded_at = ${new Date().toISOString()}, funding_ref = ${funding_ref || null}
      WHERE id = ${id}`;
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ id, status: 'funded' }) };
  } catch (err) { console.error('[fund-vxpay]', err); return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) }; }
}
