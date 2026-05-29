// netlify/functions/create-proof-solo.js
// Phase 1 of file delivery: returns signed upload URL + creates pending proof record
// Phase 2 (finalize-proof.js) is called after file upload completes

import { createHash, randomBytes } from 'crypto';
import { createClient } from '@supabase/supabase-js';

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

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cookie',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Credentials': 'true'
};

const MAX_FILE_SIZE = 104857600; // 100MB

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const user = await verifySession(event);
  if (!user) return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Authentication required. Please sign in.' }) };

  const now = new Date();
  const planExpiry = user.plan_expires_at ? new Date(user.plan_expires_at) : null;
  const hasSoloPlan = user.plan === 'solo' && planExpiry && planExpiry > now;
  if (!hasSoloPlan) return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Solo plan required for file delivery. Please upgrade at /pricing.' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const { fileHash, fileName, fileSize, fileSizeBytes, fileMimeType, timestamp, recipientEmail, projectName, includeFile, deliveryMessage } = body;

  // Validation
  if (!fileHash || fileHash.length !== 64) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid file hash' }) };
  if (!fileName) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'File name required' }) };
  if (!fileSize) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'File size required' }) };
  if (!timestamp) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Timestamp required' }) };
  if (!recipientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Valid client email required' }) };
  }

  // If file delivery requested, validate size
  if (includeFile && fileSizeBytes && fileSizeBytes > MAX_FILE_SIZE) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'File too large. Maximum 100MB on Solo plan.' }) };
  }

  try {
    const supabase = getSupabase();
    const proofId = generateProofId();
    const fileStoragePath = includeFile ? `${proofId}/${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}` : null;

    // Create pending proof record (will be finalized after upload completes, or immediately if no file)
    const proofRecord = {
      id: proofId,
      file_name: fileName,
      file_size: fileSize,
      file_size_bytes: fileSizeBytes || null,
      file_hash: fileHash,
      file_mime_type: fileMimeType || null,
      sealed_at: timestamp,
      stripe_payment_id: `solo_plan_${proofId}`,
      user_id: user.id,
      user_email: user.email,
      recipient_email: recipientEmail,
      project_name: projectName || null,
      delivery_message: (deliveryMessage || '').slice(0, 2000) || null,
      rac_enabled: true,
      rac_level: 3,
      is_valid: !includeFile, // If file included, mark valid only after upload finalize
      recipient_confirmed: false,
      file_delivery_enabled: !!includeFile,
      file_storage_path: fileStoragePath,
      file_expires_at: includeFile ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() : null
    };

    const { error: insertError } = await supabase.from('proofs').insert(proofRecord);
    if (insertError) {
      console.error('[create-proof-solo] Insert error:', JSON.stringify(insertError));
      throw new Error(`DB insert failed: ${insertError.message}`);
    }

    // If no file delivery requested, finalize immediately (proof-only flow)
    if (!includeFile) {
      // Call finalize logic inline by importing from finalize-proof
      const { finalizeProof } = await import('./_proof-finalize-helper.js').catch(() => ({ finalizeProof: null }));
      if (finalizeProof) {
        await finalizeProof({ proofId, user, recipientEmail, fileName, fileSize, fileHash, projectName, timestamp, deliveryMessage: (deliveryMessage || '').slice(0, 2000) });
      } else {
        // Fallback: send emails directly
        await sendEmails({ user, recipientEmail, proofId, fileName, fileSize, timestamp });
      }

      const baseUrl = process.env.URL || 'https://vxsent.com';
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          proofId,
          receiptUrl: `${baseUrl}/receipt?id=${proofId}`,
          fileDelivery: false
        })
      };
    }

    // File delivery: generate signed upload URL
    const { data: signedUploadData, error: uploadUrlError } = await supabase.storage
      .from('proof-files')
      .createSignedUploadUrl(fileStoragePath);

    if (uploadUrlError) {
      console.error('[create-proof-solo] Upload URL error:', JSON.stringify(uploadUrlError));
      // Rollback proof record
      await supabase.from('proofs').delete().eq('id', proofId);
      throw new Error(`Storage upload URL failed: ${uploadUrlError.message}`);
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        proofId,
        fileDelivery: true,
        uploadUrl: signedUploadData.signedUrl,
        uploadToken: signedUploadData.token,
        storagePath: fileStoragePath
      })
    };

  } catch (error) {
    console.error('[create-proof-solo] error:', error.message);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: `Failed to create proof: ${error.message}` }) };
  }
};

// Inline email helper (fallback when finalize helper not present)
async function sendEmails({ user, recipientEmail, proofId, fileName, fileSize, timestamp }) {
  const resendKey = process.env.RESEND_API_KEY;
  const baseUrl = process.env.URL || 'https://vxsent.com';
  if (!resendKey) return;

  // Sender receipt
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SENT. <receipts@vxsent.com>',
      to: user.email,
      subject: `Your SENT. receipt — ${fileName}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 20px"><h2>Proof Sealed</h2><p>Your delivery proof has been cryptographically sealed.</p><p><strong>Proof ID:</strong> ${proofId}<br><strong>File:</strong> ${fileName}<br><strong>To:</strong> ${recipientEmail}<br><strong>Sealed:</strong> ${new Date(timestamp).toUTCString()}</p><a href="${baseUrl}/receipt?id=${proofId}" style="display:inline-block;padding:14px 28px;background:#00b356;color:#fff;text-decoration:none;border-radius:4px">View Receipt</a></div>`
    })
  });

  // Recipient notification
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SENT. <receipts@vxsent.com>',
      to: recipientEmail,
      subject: `You have a verified delivery — ${fileName}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 20px"><h2>You have a verified delivery</h2><p><strong>${user.email}</strong> sent you a file with cryptographic proof.</p><p><strong>File:</strong> ${fileName}<br><strong>Proof ID:</strong> ${proofId}</p><a href="${baseUrl}/verify/${proofId}?confirm=true" style="display:inline-block;padding:14px 28px;background:#00b356;color:#fff;text-decoration:none;border-radius:4px">Confirm Receipt</a></div>`
    })
  });
}
