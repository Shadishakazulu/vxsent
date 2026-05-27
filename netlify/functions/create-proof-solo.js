// netlify/functions/create-proof-solo.js
// Direct proof creation for authenticated Solo plan users.
// No Stripe payment required — plan is already paid.

import { createHash, randomBytes } from 'crypto';
import { createClient } from '@supabase/supabase-js';

// ── HELPERS ──
function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

function generateProofId() {
  const year = new Date().getFullYear();
  const h = (n) => randomBytes(n).toString('hex').toUpperCase();
  return `SENT-${year}-${h(3)}-${h(2)}-${h(2)}-${h(2)}`;
}

function getSessionFromCookie(event) {
  const cookie = event.headers.cookie || event.headers.Cookie || '';
  const match = cookie.match(/vxsent_session=([^;]+)/);
  return match ? match[1] : null;
}

async function verifySession(event) {
  const token = getSessionFromCookie(event);
  if (!token) return null;
  const supabase = getSupabase();
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('magic_token', token)
    .gt('magic_token_expires', new Date().toISOString())
    .single();
  if (error || !user) return null;
  return user;
}

function buildRACToken({ proofId, senderEmail, recipientEmail, projectName, fileName, fileHash, timestamp }) {
  const identityHash = createHash('sha256').update(senderEmail + proofId).digest('hex');
  const scopeHash = createHash('sha256').update(`${recipientEmail || ''}:${fileName}:${fileHash}`).digest('hex');
  const chainHash = createHash('sha256').update(`${identityHash}:${scopeHash}:solo_plan:${timestamp}`).digest('hex');

  return {
    rac_version: '1.0',
    proof_id: proofId,
    action: 'authorize_delivery',
    who: {
      principal: senderEmail,
      identity_hash: identityHash,
      authority_level: 'solo_plan_member',
      role: 'content_deliverer'
    },
    which: {
      recipient: recipientEmail || 'unspecified',
      action_scope: recipientEmail ? `file_delivery → ${recipientEmail}` : 'file_delivery',
      deliverable: fileName,
      project: projectName || 'freelance_delivery',
      scope_hash: scopeHash
    },
    what: {
      confirmation_method: 'solo_plan_verified',
      payment_reference: `solo_plan_${proofId}`,
      file_hash: fileHash,
      timestamp,
      chain_hash: chainHash
    },
    minted_at: timestamp,
    chain_complete: true
  };
}

async function callVeridex({ proofId, fileHash, fileName, timestamp, racToken }) {
  const veridexUrl = process.env.VERIDEX_API_URL;
  const veridexKey = process.env.VERIDEX_API_KEY;

  if (!veridexUrl || !veridexKey) {
    // Mock mode for development
    console.warn('VERIDEX not configured — using mock');
    return {
      proof_id: proofId,
      signature: 'mock_ed25519_' + randomBytes(16).toString('hex'),
      sealed_at: timestamp,
      rac_sealed: !!racToken,
      rac_chain_hash: racToken?.what?.chain_hash || null
    };
  }

  const response = await fetch(`${veridexUrl}/v1/guardedCommit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${veridexKey}`,
      'X-Idempotency-Key': proofId,
      'X-RAC-Version': '1.0'
    },
    body: JSON.stringify({
      action: 'seal_delivery_proof',
      proof_id: proofId,
      file_hash: fileHash,
      file_name: fileName,
      timestamp,
      payment_reference: `solo_plan_${proofId}`,
      rac_token: racToken,
      metadata: { product: 'VXSent', version: '1.0', plan: 'solo' }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Veridex error: ${response.status} ${errText}`);
  }

  return response.json();
}

async function sendReceiptEmail({ email, proofId, fileName, fileSize, sealedAt, recipientEmail, racChainHash }) {
  const resendKey = process.env.RESEND_API_KEY;
  const baseUrl = process.env.URL || 'https://vxsent.com';
  const receiptUrl = `${baseUrl}/receipt?id=${proofId}`;

  if (!resendKey) { console.log('RECEIPT EMAIL (dev):', receiptUrl); return; }

  const racBlock = recipientEmail ? `
    <div style="background:rgba(0,179,86,0.06);border:1px solid rgba(0,179,86,0.2);border-radius:4px;padding:10px 14px;margin-bottom:16px">
      <div style="font-family:monospace;font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:#009347;margin-bottom:4px">✓ RAC Authorization Chain</div>
      <div style="font-size:12px;color:#374151">Authorized delivery to: <strong>${recipientEmail}</strong></div>
      ${racChainHash ? `<div style="font-family:monospace;font-size:9px;color:#6b7280;margin-top:4px">Chain: ${racChainHash.substring(0,32)}...</div>` : ''}
    </div>` : '';

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SENT. <receipts@vxsent.com>',
      to: email,
      subject: `Your SENT. receipt — ${fileName}`,
      html: `
        <div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;background:#f5f6f8">
          <div style="background:#00b356;color:#fff;padding:14px 28px;border-radius:8px 8px 0 0">
            <div style="font-family:'Bebas Neue',sans-serif;font-size:20px;letter-spacing:0.1em">✓ DELIVERY CONFIRMED AND SEALED</div>
          </div>
          <div style="background:#fff;border:1px solid #e1e4e8;border-top:none;border-radius:0 0 8px 8px;padding:32px">
            <h2 style="font-family:'Bebas Neue',sans-serif;font-size:28px;color:#111318;margin-bottom:8px">THIS FILE WAS DELIVERED.</h2>
            <p style="font-size:13px;color:#374151;line-height:1.65;margin-bottom:20px">Your delivery proof has been cryptographically sealed via your Solo plan.</p>
            ${racBlock}
            <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
              <tr style="border-bottom:1px solid #e1e4e8"><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280;width:110px">Proof ID</td><td style="padding:10px 0;font-size:11px;color:#111318;font-family:monospace">${proofId}</td></tr>
              <tr style="border-bottom:1px solid #e1e4e8"><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280">File</td><td style="padding:10px 0;font-size:11px;color:#111318">${fileName}</td></tr>
              <tr style="border-bottom:1px solid #e1e4e8"><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280">Size</td><td style="padding:10px 0;font-size:11px;color:#374151">${fileSize}</td></tr>
              <tr><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280">Sealed at</td><td style="padding:10px 0;font-size:11px;color:#00b356;font-weight:bold">${new Date(sealedAt).toUTCString()}</td></tr>
            </table>
            <a href="${receiptUrl}" style="display:inline-block;padding:14px 28px;background:#00b356;color:#fff;text-decoration:none;font-family:'Bebas Neue',sans-serif;font-size:18px;letter-spacing:0.1em;border-radius:4px">VIEW YOUR RECEIPT →</a>
          </div>
          <p style="font-size:10px;color:#9ca3af;text-align:center;margin-top:16px;font-family:monospace;text-transform:uppercase;letter-spacing:0.1em">SENT. — Powered by Veridex · EYEspAI / MegaGamer Inc.</p>
        </div>`
    })
  });
}

async function sendRecipientNotification({ recipientEmail, senderEmail, proofId, fileName, sealedAt }) {
  const resendKey = process.env.RESEND_API_KEY;
  const baseUrl = process.env.URL || 'https://vxsent.com';
  const confirmUrl = `${baseUrl}/verify/${proofId}?confirm=true`;

  if (!resendKey) { console.log('RECIPIENT NOTIFICATION (dev):', confirmUrl); return; }

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SENT. <receipts@vxsent.com>',
      to: recipientEmail,
      subject: `You have a verified delivery — ${fileName}`,
      html: `
        <div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;background:#f5f6f8">
          <div style="background:#fff;border:1px solid #e1e4e8;border-radius:8px;padding:32px;border-top:3px solid #00b356">
            <h2 style="font-size:20px;color:#111318;margin-bottom:12px">You have a verified delivery.</h2>
            <p style="font-size:14px;color:#374151;line-height:1.65;margin-bottom:16px"><strong>${senderEmail}</strong> has sent you a file with a cryptographic proof of delivery.</p>
            <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
              <tr style="border-bottom:1px solid #e1e4e8"><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280;width:100px">File</td><td style="padding:10px 0;font-size:13px;color:#111318">${fileName}</td></tr>
              <tr style="border-bottom:1px solid #e1e4e8"><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280">Proof ID</td><td style="padding:10px 0;font-size:11px;color:#111318;font-family:monospace">${proofId}</td></tr>
              <tr><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280">Sealed at</td><td style="padding:10px 0;font-size:13px;color:#00b356;font-weight:bold">${new Date(sealedAt).toUTCString()}</td></tr>
            </table>
            <a href="${confirmUrl}" style="display:inline-block;padding:14px 28px;background:#00b356;color:#fff;text-decoration:none;font-family:'Bebas Neue',sans-serif;font-size:18px;letter-spacing:0.1em;border-radius:4px">CONFIRM I RECEIVED THIS →</a>
          </div>
          <p style="font-size:10px;color:#9ca3af;text-align:center;margin-top:16px;font-family:monospace;text-transform:uppercase;letter-spacing:0.1em">SENT. — Proof of Delivery Infrastructure · vxsent.com</p>
        </div>`
    })
  });
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// ── MAIN HANDLER ──
export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  // 1. Verify authentication
  const user = await verifySession(event);
  if (!user) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Authentication required. Please sign in.' }) };
  }

  // 2. Verify Solo plan
  const now = new Date();
  const planExpiry = user.plan_expires_at ? new Date(user.plan_expires_at) : null;
  const hasSoloPlan = user.plan === 'solo' && planExpiry && planExpiry > now;

  if (!hasSoloPlan) {
    return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Solo plan required. Please upgrade at /pricing.' }) };
  }

  // 3. Parse request body
  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const { fileHash, fileName, fileSize, timestamp, recipientEmail, projectName } = body;

  // 4. Validate required fields
  if (!fileHash || fileHash.length !== 64) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid file hash' }) };
  if (!fileName) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'File name required' }) };
  if (!fileSize) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'File size required' }) };
  if (!timestamp) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Timestamp required' }) };
  if (!recipientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Valid client email required' }) };
  }

  try {
    const supabase = getSupabase();
    const proofId = generateProofId();
    const sealedAt = timestamp;

    // 5. Build RAC token (Level 3)
    const racToken = buildRACToken({
      proofId,
      senderEmail: user.email,
      recipientEmail,
      projectName,
      fileName,
      fileHash,
      timestamp
    });

    // 6. Call Veridex guardedCommit()
    const veridexResult = await callVeridex({
      proofId, fileHash, fileName, timestamp, racToken
    });

    // 7. Store proof in Supabase
    const { error: insertError } = await supabase.from('proofs').insert({
      id: proofId,
      file_name: fileName,
      file_size: fileSize,
      file_hash: fileHash,
      veridex_proof_id: veridexResult.proof_id || proofId,
      veridex_signature: veridexResult.signature,
      sealed_at: sealedAt,
      stripe_payment_id: `solo_plan_${proofId}`,
      user_id: user.id,
      user_email: user.email,
      recipient_email: recipientEmail,
      project_name: projectName || null,
      rac_chain_hash: veridexResult.rac_chain_hash || racToken.what.chain_hash,
      rac_enabled: true,
      rac_level: 3,
      is_valid: true,
      recipient_confirmed: false
    });

    if (insertError) {
      console.error('Supabase insert error:', insertError);
      throw new Error('Failed to store proof');
    }

    // 8. Send receipt email to sender
    await sendReceiptEmail({
      email: user.email,
      proofId,
      fileName,
      fileSize,
      sealedAt,
      recipientEmail,
      racChainHash: veridexResult.rac_chain_hash || racToken.what.chain_hash
    });

    // 9. Send notification email to recipient (Level 3)
    await sendRecipientNotification({
      recipientEmail,
      senderEmail: user.email,
      proofId,
      fileName,
      sealedAt
    });

    const baseUrl = process.env.URL || 'https://vxsent.com';

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        proofId,
        receiptUrl: `${baseUrl}/receipt?id=${proofId}`,
        verifyUrl: `${baseUrl}/verify/${proofId}`,
        racEnabled: true,
        chainHash: veridexResult.rac_chain_hash || racToken.what.chain_hash
      })
    };

  } catch (error) {
    console.error('create-proof-solo error:', error);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to create proof. Please try again.' }) };
  }
};
