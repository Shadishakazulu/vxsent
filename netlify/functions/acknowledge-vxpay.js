// netlify/functions/acknowledge-vxpay.js — buyer acknowledges delivery.
// Writes a tamper-evident acknowledgement hash and releases the escrow.
// Mirrors acknowledge-transfer.js (buyer confirmation hash + ip).
import { createHash } from 'crypto';
import { getDb, CORS_HEADERS } from './_vxpay-common.js';

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  try {
    const { id } = JSON.parse(event.body || '{}');
    if (!id) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing id' }) };
    const db = getDb();
    const rows = await db.sql`SELECT * FROM vxpay_agreements WHERE id = ${id}`;
    const a = rows[0];
    if (!a) return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
    if (a.status !== 'delivered') return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: `Cannot acknowledge from status '${a.status}'` }) };
    const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;
    const ts = new Date().toISOString();
    // acknowledgement hash binds the sealed agreement + ack time (tamper-evident)
    const ackHash = createHash('sha256').update(`${a.rac_chain_hash}:acknowledged:${ts}`).digest('hex');
    await db.sql`
      UPDATE vxpay_agreements SET
        status = ${'released'},
        buyer_acknowledged = ${true}, buyer_acknowledged_at = ${ts},
        buyer_acknowledgement_hash = ${ackHash}, buyer_ack_ip = ${ip},
        released_at = ${ts}
      WHERE id = ${id}`;
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ id, status: 'released', acknowledgement_hash: ackHash }) };
  } catch (err) { console.error('[acknowledge-vxpay]', err); return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) }; }
}
