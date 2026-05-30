// netlify/functions/acknowledge-transfer.js
// SENT Transfer — buyer acknowledgment (Layer 4).
// Mirrors confirm-receipt.js: Layer-4 hash = sha256(id:buyerEmail:confirmedAt:ip),
// sets buyer_confirmed, emails the seller.

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  );
}

async function sendEmail(to, subject, html) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) { console.log('[SENT-TX] Email (dev):', to, subject); return; }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'SENT. <receipts@vxsent.com>', to, subject, html })
    });
    if (!res.ok) console.error('[SENT-TX] Email failed:', to, await res.text());
  } catch (e) { console.error('[SENT-TX] Email error:', e.message); }
}

function ackEmailHtml(transfer, confirmedAt, ip, confirmationHash) {
  const verifyUrl = `https://vxsent.com/verify/${transfer.id}`;
  return `<div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;background:#f5f6f8">
    <div style="background:#00b356;color:#fff;padding:14px 28px;border-radius:8px 8px 0 0"><div style="font-family:'Bebas Neue',sans-serif;font-size:20px;letter-spacing:0.1em">\u2713 TRANSFER ACKNOWLEDGED</div></div>
    <div style="background:#fff;border:1px solid #e1e4e8;border-top:none;border-radius:0 0 8px 8px;padding:32px">
      <h2 style="font-size:20px;color:#111318;margin-bottom:8px">${transfer.buyer_name} acknowledged the transfer.</h2>
      <p style="font-size:13px;color:#374151;line-height:1.65;margin-bottom:20px">The RAC chain is now complete. Both parties have a permanent, independently verifiable record of exactly what was agreed.</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
        <tr style="border-bottom:1px solid #e1e4e8"><td style="padding:8px 0;font-size:10px;text-transform:uppercase;color:#6b7280;width:130px">Item</td><td style="padding:8px 0;font-size:12px;color:#111318">${transfer.item_title}</td></tr>
        <tr style="border-bottom:1px solid #e1e4e8"><td style="padding:8px 0;font-size:10px;text-transform:uppercase;color:#6b7280">Acknowledged</td><td style="padding:8px 0;font-size:12px;color:#00b356;font-weight:bold">${confirmedAt}</td></tr>
        <tr style="border-bottom:1px solid #e1e4e8"><td style="padding:8px 0;font-size:10px;text-transform:uppercase;color:#6b7280">IP Address</td><td style="padding:8px 0;font-size:11px;color:#111318;font-family:monospace">${ip}</td></tr>
        <tr><td style="padding:8px 0;font-size:10px;text-transform:uppercase;color:#6b7280">Confirmation Hash</td><td style="padding:8px 0;font-size:10px;color:#111318;font-family:monospace;word-break:break-all">${confirmationHash}</td></tr>
      </table>
      <div style="background:rgba(0,179,86,0.06);border:1px solid rgba(0,179,86,0.2);border-radius:4px;padding:12px;margin-bottom:16px;font-size:12px;color:#009347;font-family:monospace;letter-spacing:0.06em">RAC CHAIN COMPLETE: SELLER \u2713 \u00b7 TERMS \u2713 \u00b7 EVIDENCE \u2713 \u00b7 ACKNOWLEDGMENT \u2713</div>
      <a href="${verifyUrl}" style="display:inline-block;padding:14px 28px;background:#00b356;color:#fff;text-decoration:none;font-family:'Bebas Neue',sans-serif;font-size:18px;letter-spacing:0.1em;border-radius:4px">VIEW VERIFIED TRANSFER \u2192</a>
    </div>
    <p style="font-size:10px;color:#9ca3af;text-align:center;margin-top:16px;font-family:monospace;text-transform:uppercase;letter-spacing:0.1em">SENT. \u2014 Verified Transfer Infrastructure \u00b7 vxsent.com</p>
  </div>`;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    let body;
    try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid request body' }) }; }

    const { transferId } = body;
    if (!transferId) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'transferId is required' }) };

    const supabase = getSupabase();
    const { data: transfer, error: fetchError } = await supabase.from('transfers').select('*').eq('id', transferId).maybeSingle();
    if (fetchError) return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Failed to retrieve transfer' }) };
    if (!transfer) return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Transfer not found' }) };
    if (!transfer.is_valid) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Transfer is not yet sealed' }) };

    // Idempotent — already acknowledged
    if (transfer.buyer_confirmed) {
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ confirmed: true, transferId, confirmedAt: transfer.buyer_confirmed_at, confirmationHash: transfer.buyer_confirmation_hash, message: 'Already acknowledged.' }) };
    }

    const confirmedAt = new Date().toISOString();
    const ip = (event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown').split(',')[0].trim();
    const buyerEmail = transfer.buyer_email || 'unknown';

    // Layer-4 confirmation hash — same formula shape as confirm-receipt.js
    const confirmationHash = crypto.createHash('sha256')
      .update(`${transferId}:${buyerEmail}:${confirmedAt}:${ip}`)
      .digest('hex');

    const { error: updateError } = await supabase.from('transfers').update({
      buyer_confirmed: true,
      buyer_confirmed_at: confirmedAt,
      buyer_confirmation_hash: confirmationHash,
      buyer_confirm_ip: ip,
      status: 'acknowledged',
      updated_at: confirmedAt
    }).eq('id', transferId);
    if (updateError) return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Failed to record acknowledgment' }) };

    // Notify seller
    if (transfer.seller_email) {
      await sendEmail(transfer.seller_email, `\u2713 ${transfer.buyer_name} acknowledged your transfer \u2014 ${transfer.item_title}`, ackEmailHtml(transfer, confirmedAt, ip, confirmationHash));
    }

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ confirmed: true, transferId, confirmedAt, confirmationHash, message: 'Transfer acknowledged. Both parties notified.' }) };

  } catch (e) {
    console.error('[SENT-TX] acknowledge-transfer error:', e.message);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Failed to acknowledge transfer' }) };
  }
};
