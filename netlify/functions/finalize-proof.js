// netlify/functions/finalize-proof.js
// Called after file upload completes successfully.
// Verifies upload, computes RAC chain, marks proof as valid, sends emails.

import { createHash, randomBytes } from 'crypto';
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

function getSessionToken(event) {
  const cookie = event.headers.cookie || event.headers.Cookie || '';
  const m1 = cookie.match(/vxsent_session=([^;]+)/);
  if (m1) return m1[1];
  const m2 = cookie.match(/session_token=([^;]+)/);
  if (m2) return m2[1];
  return null;
}

async function verifySession(event) {
  const token = getSessionToken(event);
  if (!token) return null;
  const supabase = getSupabase();
  const now = new Date().toISOString();
  let { data: user } = await supabase
    .from('users')
    .select('id, email, plan, plan_expires_at')
    .eq('session_token', token)
    .gt('session_expires_at', now)
    .single();
  if (user) return user;
  const { data: user2 } = await supabase
    .from('users')
    .select('id, email, plan, plan_expires_at')
    .eq('magic_token', token)
    .gt('magic_token_expires', now)
    .single();
  return user2 || null;
}

function buildRACChainHash({ proofId, senderEmail, recipientEmail, fileName, fileHash, timestamp }) {
  const identityHash = createHash('sha256').update(senderEmail + proofId).digest('hex');
  const scopeHash = createHash('sha256').update(`${recipientEmail || ''}:${fileName}:${fileHash}`).digest('hex');
  const chainHash = createHash('sha256').update(`${identityHash}:${scopeHash}:solo_plan:${timestamp}`).digest('hex');
  return chainHash;
}

async function sendSenderReceipt({ email, proofId, fileName, fileSize, sealedAt, recipientEmail, chainHash, hasFile }) {
  const resendKey = process.env.RESEND_API_KEY;
  const baseUrl = process.env.URL || 'https://vxsent.com';
  if (!resendKey) return;

  const fileBlock = hasFile ? `
    <div style="background:rgba(0,179,86,0.06);border:1px solid rgba(0,179,86,0.2);border-radius:4px;padding:12px 16px;margin:16px 0">
      <div style="font-family:monospace;font-size:10px;color:#009347;letter-spacing:0.14em;text-transform:uppercase;margin-bottom:4px">🔒 Gated File Delivery</div>
      <div style="font-size:13px;color:#374151">Your file is locked. It will only be released when <strong>${recipientEmail}</strong> acknowledges receipt.</div>
      <div style="font-size:12px;color:#6b7280;margin-top:6px">Auto-deletes 30 minutes after confirmed download · Or 7 days if not downloaded</div>
    </div>` : '';

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SENT. <receipts@vxsent.com>',
      to: email,
      subject: `Your SENT. receipt — ${fileName}`,
      html: `<div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;background:#f5f6f8">
        <div style="background:#00b356;color:#fff;padding:14px 28px;border-radius:8px 8px 0 0"><div style="font-family:'Bebas Neue',sans-serif;font-size:20px;letter-spacing:0.1em">✓ PROOF SEALED</div></div>
        <div style="background:#fff;border:1px solid #e1e4e8;border-top:none;border-radius:0 0 8px 8px;padding:32px">
          <h2 style="font-family:'Bebas Neue',sans-serif;font-size:28px;color:#111318;margin-bottom:8px">${hasFile ? 'YOUR FILE IS LOCKED.' : 'THIS FILE WAS DELIVERED.'}</h2>
          <p style="font-size:13px;color:#374151;line-height:1.65;margin-bottom:20px">${hasFile ? `Sealed via your Solo plan. ${recipientEmail} must acknowledge receipt before they can download.` : 'Sealed via your Solo plan.'}</p>
          ${fileBlock}
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
            <tr style="border-bottom:1px solid #e1e4e8"><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280;width:110px">Proof ID</td><td style="padding:10px 0;font-size:11px;color:#111318;font-family:monospace">${proofId}</td></tr>
            <tr style="border-bottom:1px solid #e1e4e8"><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280">File</td><td style="padding:10px 0;font-size:11px;color:#111318">${fileName}</td></tr>
            <tr style="border-bottom:1px solid #e1e4e8"><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280">Size</td><td style="padding:10px 0;font-size:11px;color:#374151">${fileSize}</td></tr>
            <tr><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280">Sealed</td><td style="padding:10px 0;font-size:11px;color:#00b356;font-weight:bold">${new Date(sealedAt).toUTCString()}</td></tr>
          </table>
          <a href="${baseUrl}/receipt?id=${proofId}" style="display:inline-block;padding:14px 28px;background:#00b356;color:#fff;text-decoration:none;font-family:'Bebas Neue',sans-serif;font-size:18px;letter-spacing:0.1em;border-radius:4px">VIEW YOUR RECEIPT →</a>
        </div>
        <p style="font-size:10px;color:#9ca3af;text-align:center;margin-top:16px;font-family:monospace;text-transform:uppercase;letter-spacing:0.1em">SENT. — Powered by Veridex · EYEspAI / MegaGamer Inc.</p>
      </div>`
    })
  });
}

async function sendRecipientNotification({ recipientEmail, senderEmail, proofId, fileName, sealedAt, hasFile }) {
  const resendKey = process.env.RESEND_API_KEY;
  const baseUrl = process.env.URL || 'https://vxsent.com';
  if (!resendKey) return;

  const cta = hasFile ? 'ACKNOWLEDGE & DOWNLOAD' : 'CONFIRM I RECEIVED THIS';
  const subject = hasFile ? `${senderEmail} sent you a file — acknowledge to download` : `You have a verified delivery — ${fileName}`;
  const intro = hasFile 
    ? `<strong>${senderEmail}</strong> has sent you a file. To download it, you'll need to acknowledge receipt. This acknowledgment is cryptographically sealed.`
    : `<strong>${senderEmail}</strong> has sent you a file with a cryptographic proof of delivery.`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SENT. <receipts@vxsent.com>',
      to: recipientEmail,
      subject,
      html: `<div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;background:#f5f6f8">
        <div style="background:#fff;border:1px solid #e1e4e8;border-radius:8px;padding:32px;border-top:3px solid #00b356">
          <h2 style="font-size:20px;color:#111318;margin-bottom:12px">${hasFile ? 'You have a file delivery.' : 'You have a verified delivery.'}</h2>
          <p style="font-size:14px;color:#374151;line-height:1.65;margin-bottom:24px">${intro}</p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
            <tr style="border-bottom:1px solid #e1e4e8"><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280;width:100px">File</td><td style="padding:10px 0;font-size:13px;color:#111318">${fileName}</td></tr>
            <tr style="border-bottom:1px solid #e1e4e8"><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280">Proof ID</td><td style="padding:10px 0;font-size:11px;color:#111318;font-family:monospace">${proofId}</td></tr>
            <tr><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280">Sealed</td><td style="padding:10px 0;font-size:13px;color:#00b356;font-weight:bold">${new Date(sealedAt).toUTCString()}</td></tr>
          </table>
          <a href="${baseUrl}/verify/${proofId}?confirm=true" style="display:inline-block;padding:14px 28px;background:#00b356;color:#fff;text-decoration:none;font-family:'Bebas Neue',sans-serif;font-size:18px;letter-spacing:0.1em;border-radius:4px">${cta} →</a>
          ${hasFile ? '<p style="font-size:11px;color:#6b7280;margin-top:16px;line-height:1.5">⏱️ This file will expire in 7 days if not downloaded. After download it auto-deletes in 30 minutes for your privacy.</p>' : ''}
        </div>
        <p style="font-size:10px;color:#9ca3af;text-align:center;margin-top:16px;font-family:monospace;text-transform:uppercase;letter-spacing:0.1em">SENT. — Proof of Delivery Infrastructure · vxsent.com</p>
      </div>`
    })
  });
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cookie',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Credentials': 'true'
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const user = await verifySession(event);
  if (!user) return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Authentication required' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const { proofId, uploadSuccess } = body;
  if (!proofId) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Proof ID required' }) };

  try {
    const supabase = getSupabase();

    // Get the pending proof
    const { data: proof, error: fetchError } = await supabase
      .from('proofs')
      .select('*')
      .eq('id', proofId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (fetchError || !proof) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Proof not found' }) };
    }

    if (!uploadSuccess) {
      // Upload failed — clean up
      if (proof.file_storage_path) {
        await supabase.storage.from('proof-files').remove([proof.file_storage_path]);
      }
      await supabase.from('proofs').delete().eq('id', proofId);
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Upload failed — proof cancelled' }) };
    }

    // Verify file actually exists in storage
    if (proof.file_storage_path) {
      const { data: fileCheck } = await supabase.storage
        .from('proof-files')
        .list(proofId, { limit: 1 });
      if (!fileCheck || fileCheck.length === 0) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'File upload not detected. Please try again.' }) };
      }
    }

    // Compute RAC chain hash
    const chainHash = buildRACChainHash({
      proofId,
      senderEmail: user.email,
      recipientEmail: proof.recipient_email,
      fileName: proof.file_name,
      fileHash: proof.file_hash,
      timestamp: proof.sealed_at
    });

    // Generate Ed25519 signature (mock for now — real Veridex integration TBD)
    const veridexSignature = `mock_ed25519_${randomBytes(16).toString('hex')}`;

    // Finalize proof
    const { error: updateError } = await supabase
      .from('proofs')
      .update({
        is_valid: true,
        rac_chain_hash: chainHash,
        veridex_signature: veridexSignature,
        veridex_proof_id: proofId,
        file_uploaded_at: proof.file_storage_path ? new Date().toISOString() : null
      })
      .eq('id', proofId);

    if (updateError) {
      console.error('[finalize-proof] Update error:', JSON.stringify(updateError));
      throw new Error('Failed to finalize proof');
    }

    // Send emails
    await sendSenderReceipt({
      email: user.email,
      proofId,
      fileName: proof.file_name,
      fileSize: proof.file_size,
      sealedAt: proof.sealed_at,
      recipientEmail: proof.recipient_email,
      chainHash,
      hasFile: !!proof.file_storage_path
    });

    await sendRecipientNotification({
      recipientEmail: proof.recipient_email,
      senderEmail: user.email,
      proofId,
      fileName: proof.file_name,
      sealedAt: proof.sealed_at,
      hasFile: !!proof.file_storage_path
    });

    const baseUrl = process.env.URL || 'https://vxsent.com';
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        proofId,
        receiptUrl: `${baseUrl}/receipt?id=${proofId}`,
        chainHash,
        fileDelivery: !!proof.file_storage_path
      })
    };

  } catch (error) {
    console.error('[finalize-proof] error:', error.message);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: `Finalize failed: ${error.message}` }) };
  }
};
