// src/lib/index.js
// Shared utilities — with RAC (Request Authorization Chain) integration
// RAC maps the three-layer chain from the Veridex RAC Engine:
//   Layer 1 — WHO:   principal identity (freelancer)
//   Layer 2 — WHICH: scope/policy (project + deliverable + recipient)
//   Layer 3 — WHAT:  confirmation (payment + file hash + timestamp)

import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { randomBytes, createHash } from 'crypto';

// ── SUPABASE CLIENT ──
export function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );
}

// ── STRIPE CLIENT ──
export function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2023-10-16'
  });
}

// ── GENERATE PROOF ID ──
export function generateProofId() {
  const year = new Date().getFullYear();
  const h = (n) => randomBytes(n).toString('hex').toUpperCase();
  return `SENT-${year}-${h(3)}-${h(2)}-${h(2)}-${h(2)}`;
}

// ── BUILD RAC TOKEN ──
// The three-layer Request Authorization Chain.
// This is what transforms a timestamp into a delivery authorization.
//
// Without RAC: "This file existed at time X."
// With RAC:    "This file was authorized for delivery by [sender]
//               to [recipient] under [scope] at time X."
//
export function buildRACToken({
  proofId,
  senderEmail,          // WHO: freelancer identity
  recipientEmail,       // WHICH: authorized recipient
  projectName,          // WHICH: project scope
  fileName,             // WHICH: specific deliverable
  fileHash,             // WHAT: file fingerprint
  paymentId,            // WHAT: payment confirmation
  timestamp,            // WHAT: moment of authorization
  scopeRef = null       // optional: Scope Lock proof ID reference
}) {

  // Layer 1 — WHO: Principal identity
  const who = {
    principal: senderEmail,
    identity_hash: createHash('sha256').update(senderEmail + proofId).digest('hex'),
    authority_level: 'freelancer_delivery',
    role: 'content_deliverer'
  };

  // Layer 2 — WHICH: Scope and governance
  const which = {
    recipient: recipientEmail || 'unspecified',
    action_scope: recipientEmail
      ? `file_delivery → ${recipientEmail}`
      : 'file_delivery → client',
    deliverable: fileName,
    project: projectName || 'freelance_delivery',
    // Scope hash binds recipient + file + hash together
    scope_hash: createHash('sha256')
      .update(`${recipientEmail || ''}:${fileName}:${fileHash}`)
      .digest('hex'),
    scope_lock_ref: scopeRef || null
  };

  // Layer 3 — WHAT: Confirmation
  const what = {
    confirmation_method: 'stripe_payment_verified',
    payment_reference: paymentId,
    file_hash: fileHash,
    timestamp,
    // Chain hash — cryptographically binds all three layers
    chain_hash: createHash('sha256')
      .update(`${who.identity_hash}:${which.scope_hash}:${paymentId}:${timestamp}`)
      .digest('hex')
  };

  return {
    rac_version: '1.0',
    proof_id: proofId,
    action: 'authorize_delivery',
    who,
    which,
    what,
    minted_at: timestamp,
    chain_complete: !!(senderEmail && fileHash && paymentId)
  };
}

// ── VERIDEX guardedCommit() WITH RAC ──
// Seals the full RAC token, not just file metadata.
// Every delivery goes through this single authorized path.
export async function veridexGuardedCommit({
  proofId,
  fileHash,
  fileName,
  timestamp,
  paymentId,
  senderEmail = null,
  recipientEmail = null,
  projectName = null,
  scopeRef = null,
  racToken = null
}) {
  // Build RAC token if fields are available
  const rac = racToken || (senderEmail ? buildRACToken({
    proofId, senderEmail, recipientEmail,
    projectName, fileName, fileHash,
    paymentId, timestamp, scopeRef
  }) : null);

  const veridexUrl = process.env.VERIDEX_API_URL;
  const veridexKey = process.env.VERIDEX_API_KEY;

  if (!veridexUrl || !veridexKey) {
    console.warn('VERIDEX_API_URL not set — mock RAC proof');
    return {
      proof_id: proofId,
      signature: 'mock_ed25519_' + randomBytes(16).toString('hex'),
      sealed_at: timestamp,
      algorithm: 'Ed25519',
      hash_algorithm: 'SHA-256',
      rac_sealed: !!rac,
      rac_chain_hash: rac?.what?.chain_hash || null,
      rac_receipt: rac ? {
        who_verified: true,
        which_bound: true,
        what_confirmed: true,
        chain_hash: rac.what.chain_hash
      } : null
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
      payment_reference: paymentId,
      // Full RAC chain passed to Veridex
      rac_token: rac,
      metadata: {
        product: 'VXSent',
        version: '1.0',
        rac_enabled: !!rac
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Veridex guardedCommit failed: ${response.status} ${errText}`);
  }

  return response.json();
}

// ── SEND RECEIPT EMAIL ──
export async function sendReceiptEmail({
  email, proofId, fileName, fileSize, sealedAt,
  recipientEmail = null, racChainHash = null
}) {
  const resendKey = process.env.RESEND_API_KEY;
  const baseUrl = process.env.URL || 'https://vxsent.com';
  const receiptUrl = `${baseUrl}/receipt?id=${proofId}`;

  if (!resendKey) { console.log(`RECEIPT EMAIL (dev): ${receiptUrl}`); return; }

  const racBlock = (recipientEmail || racChainHash) ? `
    <div style="background:rgba(0,179,86,0.06);border:1px solid rgba(0,179,86,0.2);border-radius:4px;padding:10px 14px;margin-bottom:16px">
      <div style="font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:#009347;margin-bottom:4px">✓ RAC Authorization Chain</div>
      ${recipientEmail ? `<div style="font-size:12px;color:#374151">Authorized delivery to: <strong>${recipientEmail}</strong></div>` : ''}
      ${racChainHash ? `<div style="font-family:'JetBrains Mono',monospace;font-size:9px;color:#6b7280;margin-top:4px">Chain: ${racChainHash.substring(0,32)}...</div>` : ''}
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
            <p style="font-size:13px;color:#374151;line-height:1.65;margin-bottom:20px">Your delivery proof has been cryptographically sealed. Permanent and independently verifiable.</p>
            ${racBlock}
            <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
              <tr style="border-bottom:1px solid #e1e4e8"><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280;width:110px">Proof ID</td><td style="padding:10px 0;font-size:11px;color:#111318;font-family:monospace">${proofId}</td></tr>
              <tr style="border-bottom:1px solid #e1e4e8"><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280">File</td><td style="padding:10px 0;font-size:11px;color:#111318">${fileName}</td></tr>
              <tr style="border-bottom:1px solid #e1e4e8"><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280">Size</td><td style="padding:10px 0;font-size:11px;color:#374151">${fileSize}</td></tr>
              <tr><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280">Sealed at</td><td style="padding:10px 0;font-size:11px;color:#00b356;font-weight:bold">${new Date(sealedAt).toUTCString()}</td></tr>
            </table>
            <a href="${receiptUrl}" style="display:inline-block;padding:14px 28px;background:#00b356;color:#fff;text-decoration:none;font-family:'Bebas Neue',sans-serif;font-size:18px;letter-spacing:0.1em;border-radius:4px">VIEW YOUR RECEIPT →</a>
          </div>
          <p style="font-size:10px;color:#9ca3af;text-align:center;margin-top:16px;font-family:'JetBrains Mono',monospace;text-transform:uppercase;letter-spacing:0.1em">SENT. — Powered by Veridex · EYEspAI / MegaGamer Inc.</p>
        </div>`
    })
  });
}

// ── HABIT EMAIL ──
export async function sendHabitEmail({ email }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) { console.log('HABIT EMAIL (dev):', email); return; }
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SENT. <hello@vxsent.com>', to: email,
      subject: 'Next time you send work — do this first',
      html: `<div style="font-family:'DM Sans',sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;background:#f5f6f8"><div style="background:#fff;border:1px solid #e1e4e8;border-radius:8px;padding:36px;border-top:3px solid #00b356"><p style="font-size:16px;font-weight:700;color:#111318;margin-bottom:16px">Before you send any file:</p><div style="background:#f0f2f5;border-radius:6px;padding:20px 24px;margin-bottom:20px"><div style="font-family:'JetBrains Mono',monospace;font-size:13px;color:#374151;line-height:2.2"><div>1. Drop it into SENT.</div><div>2. Create proof</div><div>3. Paste the link with your delivery</div></div></div><p style="font-size:14px;color:#374151;line-height:1.65;margin-bottom:20px">Skip this once, and that's the one time it matters.</p><a href="https://vxsent.com" style="display:inline-block;padding:13px 24px;background:#00b356;color:#fff;text-decoration:none;font-family:'Bebas Neue',sans-serif;font-size:17px;letter-spacing:0.1em;border-radius:4px">PROOF YOUR NEXT FILE →</a></div></div>`
    })
  });
}

// ── SUBSCRIPTION NUDGE ──
export async function sendSubscriptionNudge({ email, proofCount }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) { console.log('SUBSCRIPTION NUDGE (dev):', email); return; }
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SENT. <hello@vxsent.com>', to: email,
      subject: `You've created ${proofCount} proofs — unlimited is $12.99`,
      html: `<div style="font-family:'DM Sans',sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;background:#f5f6f8"><div style="background:#fff;border:1px solid #e1e4e8;border-radius:8px;padding:36px;border-top:3px solid #00b356"><p style="font-size:16px;font-weight:700;color:#111318;margin-bottom:8px">You've created ${proofCount} proofs.</p><p style="font-size:14px;color:#374151;line-height:1.65;margin-bottom:20px">At $0.99 each you've spent $${(proofCount*0.99).toFixed(2)}. Unlimited is <strong>$12.99/month</strong>.</p><a href="https://vxsent.com/pricing" style="display:inline-block;padding:13px 24px;background:#00b356;color:#fff;text-decoration:none;font-family:'Bebas Neue',sans-serif;font-size:17px;letter-spacing:0.1em;border-radius:4px">GO UNLIMITED →</a></div></div>`
    })
  });
}

// ── MAGIC LINK EMAIL ──
export async function sendMagicLinkEmail({ email, token }) {
  const baseUrl = process.env.URL || 'https://vxsent.com';
  const link = `${baseUrl}/api/auth/verify?token=${token}&email=${encodeURIComponent(email)}`;
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) { console.log(`MAGIC LINK (dev): ${link}`); return; }
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SENT. <noreply@vxsent.com>', to: email,
      subject: 'Sign in to SENT.',
      html: `<div style="font-family:'DM Sans',sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;background:#f5f6f8"><div style="background:#fff;border:1px solid #e1e4e8;border-radius:8px;padding:36px;border-top:3px solid #00b356"><p style="font-size:14px;color:#374151;margin-bottom:24px">Click below to sign in. Expires in 15 minutes.</p><a href="${link}" style="display:inline-block;padding:14px 28px;background:#00b356;color:#fff;text-decoration:none;font-family:'Bebas Neue',sans-serif;font-size:18px;letter-spacing:0.1em;border-radius:4px">SIGN IN →</a></div></div>`
    })
  });
}

// ── HTTP HELPERS ──
const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': process.env.URL || 'https://vxsent.com',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
export const ok = (data, status = 200) => ({ statusCode: status, headers: CORS_HEADERS, body: JSON.stringify(data) });
export const err = (message, status = 400) => ({ statusCode: status, headers: CORS_HEADERS, body: JSON.stringify({ error: message }) });
export const cors = () => ({ statusCode: 204, headers: CORS_HEADERS, body: '' });

export function getSessionFromCookie(event) {
  const cookie = event.headers.cookie || '';
  const match = cookie.match(/vxsent_session=([^;]+)/);
  return match ? match[1] : null;
}

export async function verifySession(event) {
  const token = getSessionFromCookie(event);
  if (!token) return null;
  const supabase = getSupabase();
  const { data: user, error } = await supabase
    .from('users').select('*')
    .eq('magic_token', token)
    .gt('magic_token_expires', new Date().toISOString())
    .single();
  if (error || !user) return null;
  return user;
}
