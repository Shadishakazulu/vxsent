// src/lib/index.js
// SENT. RAC v1 — Shared library functions
// Supabase helpers, email functions, utility exports

const { createClient } = require('@supabase/supabase-js');

// ─── Supabase Client ──────────────────────────────────────────────────────────

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase credentials not configured');
  return createClient(url, key);
}

// ─── Response Helpers ─────────────────────────────────────────────────────────

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function ok(data) {
  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify(data)
  };
}

function err(message, statusCode = 400) {
  return {
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify({ error: message })
  };
}

function cors() {
  return {
    statusCode: 200,
    headers: corsHeaders
  };
}

// ─── Recipient Notification Email ─────────────────────────────────────────────

async function sendRecipientNotification({
  recipientEmail,
  senderEmail,
  proofId,
  fileName,
  sealedAt
}) {
  const resendKey = process.env.RESEND_API_KEY;
  const baseUrl = process.env.URL || 'https://vxsent.com';
  const confirmUrl = `${baseUrl}/verify/${proofId}?confirm=true`;

  if (!resendKey ) {
    console.log('RECIPIENT NOTIFICATION (dev):', confirmUrl);
    return;
  }

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'SENT. <receipts@vxsent.com>',
      to: recipientEmail,
      subject: `You have a verified delivery — ${fileName}`,
      html: `
        <div style="font-family:'DM Sans',sans-serif;
          max-width:560px;margin:0 auto;
          padding:40px 20px;background:#f5f6f8">
          <div style="background:#fff;
            border:1px solid #e1e4e8;
            border-radius:8px;padding:32px;
            border-top:3px solid #00b356">

            <div style="font-family:'Bebas Neue',
              sans-serif;font-size:22px;
              letter-spacing:0.15em;
              color:#111318;margin-bottom:20px">
              SENT.
            </div>

            <h2 style="font-size:20px;
              color:#111318;margin-bottom:12px">
              You have a verified delivery.
            </h2>

            <p style="font-size:14px;color:#374151;
              line-height:1.65;margin-bottom:8px">
              <strong>${senderEmail}</strong> has sent
              you a file with a cryptographic proof
              of delivery.
            </p>

            <table style="width:100%;
              border-collapse:collapse;
              margin-bottom:24px;margin-top:16px">
              <tr style="border-bottom:
                1px solid #e1e4e8">
                <td style="padding:10px 0;
                  font-size:10px;
                  text-transform:uppercase;
                  letter-spacing:0.12em;
                  color:#6b7280;width:100px">
                  File
                </td>
                <td style="padding:10px 0;
                  font-size:13px;color:#111318">
                  ${fileName}
                </td>
              </tr>
              <tr style="border-bottom:
                1px solid #e1e4e8">
                <td style="padding:10px 0;
                  font-size:10px;
                  text-transform:uppercase;
                  letter-spacing:0.12em;
                  color:#6b7280">
                  Proof ID
                </td>
                <td style="padding:10px 0;
                  font-size:11px;color:#111318;
                  font-family:monospace">
                  ${proofId}
                </td>
              </tr>
              <tr>
                <td style="padding:10px 0;
                  font-size:10px;
                  text-transform:uppercase;
                  letter-spacing:0.12em;
                  color:#6b7280">
                  Sealed at
                </td>
                <td style="padding:10px 0;
                  font-size:13px;color:#00b356;
                  font-weight:bold">
                  ${new Date(sealedAt ).toUTCString()}
                </td>
              </tr>
            </table>

            <a href="${confirmUrl}"
              style="display:inline-block;
              padding:14px 28px;
              background:#00b356;color:#fff;
              text-decoration:none;
              font-family:'Bebas Neue',sans-serif;
              font-size:18px;letter-spacing:0.1em;
              border-radius:4px">
              CONFIRM I RECEIVED THIS →
            </a>

            <p style="font-size:11px;color:#9ca3af;
              margin-top:20px;
              font-family:'JetBrains Mono',monospace;
              text-transform:uppercase;
              letter-spacing:0.1em">
              You can also view and verify this proof
              without confirming. No account required.
            </p>
          </div>

          <p style="font-size:10px;color:#9ca3af;
            text-align:center;margin-top:16px;
            font-family:'JetBrains Mono',monospace;
            text-transform:uppercase;
            letter-spacing:0.1em">
            SENT. — Proof of Delivery Infrastructure
            · vxsent.com
          </p>
        </div>
      `
    })
  });
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  getSupabase,
  ok,
  err,
  cors,
  corsHeaders,
  sendRecipientNotification
};
