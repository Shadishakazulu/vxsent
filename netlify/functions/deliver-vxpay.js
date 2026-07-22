// netlify/functions/deliver-vxpay.js — seller marks the item delivered.
// Requires funded status. Opens the buyer inspection window.
import { getDb, CORS_HEADERS } from './_vxpay-common.js';

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  try {
    const { id, delivery_note } = JSON.parse(event.body || '{}');
    if (!id) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing id' }) };
    const db = getDb();
    const rows = await db.sql`SELECT status FROM vxpay_agreements WHERE id = ${id}`;
    const a = rows[0];
    if (!a) return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
    if (a.status !== 'funded') return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: `Cannot deliver from status '${a.status}'` }) };
    await db.sql`
      UPDATE vxpay_agreements
      SET status = ${'delivered'}, delivered_at = ${new Date().toISOString()}, delivery_note = ${delivery_note || null}
      WHERE id = ${id}`;
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ id, status: 'delivered' }) };
  } catch (err) { console.error('[deliver-vxpay]', err); return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) }; }
}
