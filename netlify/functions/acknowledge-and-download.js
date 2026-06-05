// netlify/functions/acknowledge-and-download.js
// Recipient endpoint: confirms receipt AND returns signed download URL.
// This is the moment that triggers Layer 4 of the RAC chain.
// No authentication required — anyone with the proof link can acknowledge.

import { createHash } from 'crypto';
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const { proofId, recipientEmail } = body;
  if (!proofId) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Proof ID required' }) };

  const ipAddress = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
  const userAgent = event.headers['user-agent'] || 'unknown';
  const acknowledgedAt = new Date().toISOString();

  try {
    const supabase = getSupabase();

    // Get the proof
    const { data: proof, error: fetchError } = await supabase
      .from('proofs')
      .select('*')
      .eq('id', proofId)
      .eq('is_valid', true)
      .maybeSingle();

    if (fetchError || !proof) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Proof not found or not valid' }) };
    }

    // Check if revoked
    if (proof.revoked_at) {
      return { statusCode: 410, headers: CORS_HEADERS, body: JSON.stringify({ error: 'This proof has been revoked by the sender' }) };
    }

    // Check if file expired
    if (proof.file_expires_at && new Date(proof.file_expires_at) < new Date()) {
      return { statusCode: 410, headers: CORS_HEADERS, body: JSON.stringify({ error: 'File expired. Contact sender for a new delivery.' }) };
    }

    // Check if already deleted
    if (proof.file_deleted_at) {
      return { statusCode: 410, headers: CORS_HEADERS, body: JSON.stringify({ error: 'File has been deleted. The proof receipt remains valid.' }) };
    }

    // Compute Layer 4 confirmation hash
    const confirmationHash = createHash('sha256')
      .update(`${proofId}:${proof.recipient_email}:${acknowledgedAt}:${ipAddress}`)
      .digest('hex');

    // Update proof with acknowledgment
    const isFirstDownload = !proof.first_download_at;
    const updates = {
      recipient_confirmed: true,
      recipient_confirmed_at: proof.recipient_confirmed_at || acknowledgedAt,
      recipient_confirmation_hash: proof.recipient_confirmation_hash || confirmationHash,
      download_count: (proof.download_count || 0) + 1,
      last_download_at: acknowledgedAt
    };
    if (isFirstDownload) {
      updates.first_download_at = acknowledgedAt;
      // Schedule deletion 30 minutes from now
      updates.deletion_scheduled_at = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    }

    const { error: updateError } = await supabase
      .from('proofs')
      .update(updates)
      .eq('id', proofId);

    if (updateError) {
      console.error('[acknowledge] Update error:', JSON.stringify(updateError));
      throw new Error('Failed to record acknowledgment');
    }

    // Log access event
    try {
      await supabase.from('proof_access_events').insert({
        proof_id: proofId,
        accessed_at: acknowledgedAt,
        ip_address: ipAddress,
        user_agent: userAgent,
        referrer: event.headers['referer'] || null,
        confirmed: true
      });
    } catch (logErr) { /* non-fatal */ }

    // If proof has a file, generate signed download URL
    let downloadUrl = null;
    if (proof.file_storage_path) {
      // Pass `download` so Supabase serves the file with a
      // `Content-Disposition: attachment` header. Without it the file is served
      // inline with its native content type, and because the signed URL lives on
      // a different origin (*.supabase.co) the browser ignores the <a download>
      // attribute and instead navigates to the raw URL — rendering HTML/text
      // files as a wall of source text in the address bar instead of downloading.
      const { data: signedData, error: signError } = await supabase.storage
        .from('proof-files')
        .createSignedUrl(proof.file_storage_path, 1800, { download: proof.file_name || true }); // 30 min validity, force download

      if (signError) {
        console.error('[acknowledge] Sign URL error:', JSON.stringify(signError));
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to generate download URL' }) };
      }
      downloadUrl = signedData.signedUrl;
    }

    // Notify sender that file was downloaded (only on first download)
    if (isFirstDownload) {
      const resendKey = process.env.RESEND_API_KEY;
      const baseUrl = process.env.URL || 'https://vxsent.com';
      if (resendKey) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'SENT. <receipts@vxsent.com>',
            to: proof.user_email,
            subject: `✓ ${proof.recipient_email} acknowledged your file`,
            html: `<div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;background:#f5f6f8">
              <div style="background:#fff;border:1px solid #e1e4e8;border-radius:8px;padding:32px;border-top:3px solid #00b356">
                <h2 style="font-size:22px;color:#111318;margin-bottom:8px">✓ Delivery Acknowledged</h2>
                <p style="font-size:14px;color:#374151;line-height:1.65;margin-bottom:16px"><strong>${proof.recipient_email}</strong> just acknowledged receipt of <strong>${proof.file_name}</strong>.</p>
                <p style="font-size:13px;color:#374151;line-height:1.65;margin-bottom:24px">This acknowledgment is now cryptographically sealed in your proof. The file will auto-delete in 30 minutes per your privacy settings.</p>
                <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
                  <tr style="border-bottom:1px solid #e1e4e8"><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280;width:130px">Acknowledged at</td><td style="padding:10px 0;font-size:12px;color:#00b356;font-weight:bold">${new Date(acknowledgedAt).toUTCString()}</td></tr>
                  <tr style="border-bottom:1px solid #e1e4e8"><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280">IP Address</td><td style="padding:10px 0;font-size:12px;color:#111318;font-family:monospace">${ipAddress}</td></tr>
                  <tr><td style="padding:10px 0;font-size:10px;text-transform:uppercase;color:#6b7280">Confirmation hash</td><td style="padding:10px 0;font-size:10px;color:#111318;font-family:monospace;word-break:break-all">${confirmationHash.substring(0,32)}...</td></tr>
                </table>
                <a href="${baseUrl}/receipt?id=${proofId}" style="display:inline-block;padding:14px 28px;background:#00b356;color:#fff;text-decoration:none;font-family:'Bebas Neue',sans-serif;font-size:18px;letter-spacing:0.1em;border-radius:4px">VIEW UPDATED RECEIPT →</a>
              </div>
              <p style="font-size:10px;color:#9ca3af;text-align:center;margin-top:16px;font-family:monospace;text-transform:uppercase;letter-spacing:0.1em">SENT. — Proof of Delivery Infrastructure · vxsent.com</p>
            </div>`
          })
        });
      }
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: true,
        confirmed: true,
        confirmationHash,
        downloadUrl,
        fileName: proof.file_name,
        downloadExpiresIn: 1800,
        deletionScheduledAt: updates.deletion_scheduled_at || proof.deletion_scheduled_at
      })
    };

  } catch (error) {
    console.error('[acknowledge] error:', error.message);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: `Acknowledgment failed: ${error.message}` }) };
  }
};
