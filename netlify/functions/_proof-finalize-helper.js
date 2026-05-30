// netlify/functions/_proof-finalize-helper.js
// Shared finalization logic: computes RAC chain, generates signature, updates proof, sends emails.
// Used by:
//   - create-proof-solo.js (no-file path — finalizes immediately after insert)
//   - finalize-proof.js (file path — finalizes after upload confirmed)
//
// CRITICAL: This is the single source of truth for RAC chain writing.
// Every proof must pass through here. Do not duplicate this logic elsewhere.

import { createHash, randomBytes } from 'crypto';
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

function buildRACChainHash({ proofId, senderEmail, recipientEmail, fileName, fileHash, timestamp, deliveryMessage }) {
  const identityHash = createHash('sha256').update(senderEmail + proofId).digest('hex');
  // deliveryMessage is folded into the scope so it is tamper-evident: altering the
  // message after sealing changes the hash and breaks verification.
  const scopeHash = createHash('sha256').update(`${recipientEmail || ''}:${fileName}:${fileHash}:${deliveryMessage || ''}`).digest('hex');
  const chainHash = createHash('sha256').update(`${identityHash}:${scopeHash}:solo_plan:${timestamp}`).digest('hex');
  return chainHash;
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function sendSenderReceipt({ email, proofId, fileName, fileSize, sealedAt, recipientEmail, hasFile, deliveryMessage }) {
  const resendKey = process.env.RESEND_API_KEY;
  const baseUrl = process.env.URL || 'https://vxsent.com';
  if (!resendKey) return;

  const msgBlock = deliveryMessage ? `
    <div style="background:#f0f2f5;border:1px solid #e1e4e8;border-radius:4px;padding:12px 16px;margin:16px 0">
      <div style="font-family:monospace;font-size:10px;color:#6b7280;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:5px">Sealed message</div>
      <div style="font-size:13px;color:#374151;line-height:1.5;white-space:pre-wrap">${escapeHtml(deliveryMessage)}</div>
    </div>` : '';

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
          ${msgBlock}
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

async function sendRecipientNotification({ recipientEmail, senderEmail, proofId, fileName, sealedAt, hasFile, deliveryMessage }) {
  const resendKey = process.env.RESEND_API_KEY;
  const baseUrl = process.env.URL || 'https://vxsent.com';
  if (!resendKey) return;

  const cta = hasFile ? 'ACKNOWLEDGE & DOWNLOAD' : 'CONFIRM I RECEIVED THIS';
  const subject = hasFile ? `${senderEmail} sent you a file — acknowledge to download` : `You have a verified delivery — ${fileName}`;
  const intro = hasFile
    ? `<strong>${senderEmail}</strong> has sent you a file. To download it, you'll need to acknowledge receipt. This acknowledgment is cryptographically sealed.`
    : `<strong>${senderEmail}</strong> has sent you a file with a cryptographic proof of delivery.`;
  // For gated file deliveries, the sealed message is withheld until the recipient
  // acknowledges receipt — otherwise they could read it without ever acknowledging.
  // For proof-only deliveries (no gated file) the message is shown as before.
  const msgBlock = !deliveryMessage
    ? ''
    : hasFile
      ? `<div style="background:#f0f2f5;border-left:3px solid #9ca3af;border-radius:4px;padding:12px 16px;margin-bottom:20px"><div style="font-family:monospace;font-size:10px;color:#6b7280;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:5px">🔒 Sealed message</div><div style="font-size:13px;color:#6b7280;line-height:1.5">${senderEmail} included a private message. It will be revealed once you acknowledge receipt below.</div></div>`
      : `<div style="background:#f0f2f5;border-left:3px solid #00b356;border-radius:4px;padding:12px 16px;margin-bottom:20px"><div style="font-family:monospace;font-size:10px;color:#6b7280;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:5px">Message from ${senderEmail}</div><div style="font-size:14px;color:#374151;line-height:1.5;white-space:pre-wrap">${escapeHtml(deliveryMessage)}</div></div>`;

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
          ${msgBlock}
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

/**
 * Finalize a proof: write RAC chain + signature, mark valid, send emails.
 * Called from create-proof-solo.js (no-file) and finalize-proof.js (with-file).
 *
 * @param {object} args
 * @param {string} args.proofId
 * @param {object} args.user - { id, email }
 * @param {string} args.recipientEmail
 * @param {string} args.fileName
 * @param {string} args.fileSize - human-readable string
 * @param {string} args.fileHash - sha256 hex
 * @param {string} args.projectName - optional
 * @param {string} args.timestamp - ISO sealedAt
 * @param {boolean} args.hasFile - true if file delivery enabled
 * @returns {object} { chainHash, veridexSignature }
 */
export async function finalizeProof({ proofId, user, recipientEmail, fileName, fileSize, fileHash, projectName, timestamp, hasFile = false, deliveryMessage = '' }) {
  const supabase = getSupabase();

  const chainHash = buildRACChainHash({
    proofId,
    senderEmail: user.email,
    recipientEmail,
    fileName,
    fileHash,
    timestamp,
    deliveryMessage
  });

  const veridexSignature = `mock_ed25519_${randomBytes(16).toString('hex')}`;

  const updates = {
    is_valid: true,
    rac_chain_hash: chainHash,
    veridex_signature: veridexSignature,
    veridex_proof_id: proofId
  };
  if (hasFile) {
    updates.file_uploaded_at = new Date().toISOString();
  }

  const { error: updateError } = await supabase
    .from('proofs')
    .update(updates)
    .eq('id', proofId);

  if (updateError) {
    console.error('[_proof-finalize-helper] Update error:', JSON.stringify(updateError));
    throw new Error(`Failed to finalize proof: ${updateError.message}`);
  }

  // Send emails (non-blocking failures shouldn't break the flow)
  try {
    await sendSenderReceipt({
      email: user.email,
      proofId,
      fileName,
      fileSize,
      sealedAt: timestamp,
      recipientEmail,
      hasFile,
      deliveryMessage
    });
    await sendRecipientNotification({
      recipientEmail,
      senderEmail: user.email,
      proofId,
      fileName,
      sealedAt: timestamp,
      hasFile,
      deliveryMessage
    });
  } catch (emailErr) {
    console.error('[_proof-finalize-helper] Email send failed (non-fatal):', emailErr.message);
  }

  return { chainHash, veridexSignature };
}
