// netlify/functions/create-proof-solo.js
// Direct proof creation for authenticated Solo plan users
// No payment required — uses Veridex to seal proof directly

import {
  getSupabase,
  veridexGuardedCommit,
  generateProofId,
  sendReceiptEmail,
  sendRecipientNotification,
  ok,
  err,
  cors,
  verifySession
} from '../../src/lib/index.js';

export const handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return cors(ok({}));
  }

  // Only POST allowed
  if (event.httpMethod !== 'POST') {
    return cors(err(405, 'Method not allowed'));
  }

  try {
    // Verify session
    const session = await verifySession(event);
    if (!session) {
      return cors(err(401, 'Unauthorized — please log in'));
    }

    const user = session;
    const supabase = getSupabase();

    // Verify user has active Solo plan
    if (user.plan !== 'solo') {
      return cors(err(403, 'Solo plan required'));
    }

    if (!user.plan_expires_at || new Date(user.plan_expires_at) < new Date()) {
      return cors(err(403, 'Solo plan expired'));
    }

    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { fileHash, fileName, fileSize, timestamp, recipientEmail, projectName } = body;

    // Validate required fields
    if (!fileHash || !fileName || !timestamp) {
      return cors(err(400, 'Missing required fields: fileHash, fileName, timestamp'));
    }

    // Generate proof ID
    const proofId = generateProofId();

    // Call Veridex to seal proof
    const veridexResult = await veridexGuardedCommit({
      proofId,
      fileHash,
      fileName,
      timestamp,
      paymentId: 'solo_plan_' + proofId,
      senderEmail: user.email,
      recipientEmail: recipientEmail || null,
      projectName: projectName || null
    });

    if (!veridexResult.success) {
      console.error('[create-proof-solo] Veridex failed:', veridexResult.error);
      return cors(err(500, 'Failed to seal proof'));
    }

    // Store proof in Supabase
    const { error: dbError } = await supabase.from('proofs').insert({
      proof_id: proofId,
      user_id: user.id,
      file_name: fileName,
      file_size: fileSize || 0,
      file_hash: fileHash,
      sender_email: user.email,
      recipient_email: recipientEmail || null,
      project_name: projectName || null,
      is_valid: true,
      rac_enabled: true,
      rac_level: 3,
      status: 'verified',
      stripe_payment_id: 'solo_plan_' + proofId,
      sealed_at: new Date().toISOString(),
      timestamp: timestamp,
      rac_chain_hash: veridexResult.chainHash || '',
      recipient_confirmed: false
    });

    if (dbError) {
      console.error('[create-proof-solo] DB insert error:', dbError);
      return cors(err(500, 'Failed to save proof'));
    }

    // Send receipt email to sender
    try {
      await sendReceiptEmail({
        to: user.email,
        proofId,
        fileName,
        fileHash,
        senderEmail: user.email,
        recipientEmail: recipientEmail || null,
        projectName: projectName || null,
        timestamp
      });
    } catch (emailErr) {
      console.warn('[create-proof-solo] Receipt email failed (non-fatal):', emailErr.message);
    }

    // Send recipient notification if email provided
    if (recipientEmail) {
      try {
        await sendRecipientNotification({
          to: recipientEmail,
          proofId,
          fileName,
          senderEmail: user.email,
          projectName: projectName || null
        });
      } catch (emailErr) {
        console.warn('[create-proof-solo] Recipient email failed (non-fatal):', emailErr.message);
      }
    }

    // Return success with receipt URL
    const receiptUrl = `${process.env.SITE_URL || 'https://vxsent.com'}/receipt?id=${proofId}`;

    return cors(ok({
      success: true,
      proofId,
      receiptUrl,
      message: 'Proof sealed successfully'
    }));

  } catch (error) {
    console.error('[create-proof-solo] Error:', error.message);
    return cors(err(500, 'Server error'));
  }
};
