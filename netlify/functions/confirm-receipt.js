// netlify/functions/confirm-receipt.js
// SENT. Master Reference v1.0 — Section 4 (Recipient Confirmation Flow)
// POST /api/confirm-receipt — Adds Layer 4 to RAC chain

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
  if (!resendKey) { console.log('[SENT] Email (dev):', to, subject); return; }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'SENT. <receipts@vxsent.com>', to, subject, html })
    });
    if (!res.ok) console.error('[SENT] Email failed:', to, await res.text());
    else console.log('[SENT] Email sent:', to);
  } catch (e) { console.error('[SENT] Email error:', e.message); }
}

function confirmationEmailHtml(proofId, fileName, confirmedAt, ip, confirmationHash) {
  const receiptUrl = `https://vxsent.com/receipt?id=${proofId}`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="background:#0a1628;color:#e0e8ff;font-family:system-ui,sans-serif;padding:32px;max-width:600px;margin:0 auto;">
  <div style="border-bottom:2px solid #00ff88;padding-bottom:16px;margin-bottom:24px;">
    <span style="color:#00ff88;font-weight:700;font-size:20px;letter-spacing:2px;">SENT.</span>
    <span style="color:#888;margin-left:8px;font-size:12px;">DELIVERY CONFIRMED</span>
  </div>
  <h2 style="color:#00ff88;margin:0 0 8px;">✓ Delivery confirmed — ${fileName}</h2>
  <p style="color:#888;margin:0 0 24px;">Your recipient has cryptographically confirmed receipt. The RAC chain is now complete.</p>
  <div style="background:#0d1f3c;border:1px solid #1a3a6b;border-radius:4px;padding:16px;margin-bottom:16px;">
    <div style="color:#00ff88;font-weight:700;margin-bottom:12px;">DELIVERY CONFIRMED BY RECIPIENT</div>
    <table style="width:100%;border-collapse:collapse;">
      <tr><td style="color:#888;padding:4px 0;font-size:13px;">FILE</td><td style="color:#e0e8ff;font-size:13px;">${fileName}</td></tr>
      <tr><td style="color:#888;padding:4px 0;font-size:13px;">CONFIRMED</td><td style="color:#e0e8ff;font-size:13px;">${confirmedAt}</td></tr>
      <tr><td style="color:#888;padding:4px 0;font-size:13px;">IP ADDRESS</td><td style="color:#e0e8ff;font-family:monospace;font-size:13px;">${ip}</td></tr>
      <tr><td style="color:#888;padding:4px 0;font-size:13px;">CONFIRMATION HASH</td><td style="color:#e0e8ff;font-family:monospace;font-size:11px;word-break:break-all;">${confirmationHash}</td></tr>
    </table>
  </div>
  <div style="background:#0a2a1a;border:1px solid #00ff88;border-radius:4px;padding:12px;margin-bottom:16px;font-size:13px;color:#00ff88;">
    RAC CHAIN COMPLETE: WHO ✓ · WHICH ✓ · WHAT ✓ · RECEIPT ✓
  </div>
  <a href="${receiptUrl}" style="display:inline-block;background:#00ff88;color:#0a1628;font-weight:700;padding:14px 28px;text-decoration:none;border-radius:4px;letter-spacing:1px;">VIEW RECEIPT →</a>
</body></html>`;
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

    const { proofId } = body;
    if (!proofId) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'proofId is required' }) };

    const supabase = getSupabase();
    const { data: proof, error: fetchError } = await supabase.from('proofs').select('*').eq('id', proofId).maybeSingle();
    if (fetchError) return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Failed to retrieve proof' }) };
    if (!proof) return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Proof not found' }) };
    if (!proof.is_valid) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Proof is not yet sealed' }) };

    if (proof.recipient_confirmed) {
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ confirmed: true, proofId, confirmedAt: proof.recipient_confirmed_at, confirmationHash: proof.recipient_confirmation_hash, message: 'Receipt confirmed. Sender notified.' }) };
    }

    const confirmedAt = new Date().toISOString();
    const ip = (event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown').split(',')[0].trim();
    const userAgent = event.headers['user-agent'] || 'unknown';
    const recipientEmail = proof.recipient_email || 'unknown';

    const confirmationHash = crypto.createHash('sha256').update(`${proofId}:${recipientEmail}:${confirmedAt}:${ip}`).digest('hex');

    const { error: updateError } = await supabase.from('proofs').update({ recipient_confirmed: true, recipient_confirmed_at: confirmedAt, recipient_confirmation_hash: confirmationHash, updated_at: confirmedAt }).eq('id', proofId);
    if (updateError) return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Failed to confirm receipt' }) };

    try { await supabase.from('proof_access_events').insert({ proof_id: proofId, accessed_at: confirmedAt, ip_address: ip, user_agent: userAgent.substring(0, 255), confirmed: true, confirmed_at: confirmedAt }); } catch (logErr) { console.warn('[SENT] Access log failed:', logErr.message); }

    if (proof.user_email) await sendEmail(proof.user_email, `✓ Delivery confirmed — ${proof.file_name}`, confirmationEmailHtml(proofId, proof.file_name, confirmedAt, ip, confirmationHash));

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ confirmed: true, proofId, confirmedAt, confirmationHash, message: 'Receipt confirmed. Sender notified.' }) };

  } catch (e) {
    console.error('[SENT] confirm-receipt unhandled error:', e.message);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Failed to confirm receipt' }) };
  }
};
