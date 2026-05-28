// netlify/functions/revoke-file.js
// Sender can delete their file early. Proof record stays — file is removed immediately.

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
  const { data: user } = await supabase
    .from('users')
    .select('id, email')
    .eq('session_token', token)
    .gt('session_expires_at', now)
    .single();
  return user || null;
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Cookie',
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

  const { proofId, reason } = body;
  if (!proofId) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Proof ID required' }) };

  try {
    const supabase = getSupabase();

    // Verify ownership
    const { data: proof, error: fetchError } = await supabase
      .from('proofs')
      .select('id, file_storage_path, user_id, file_deleted_at')
      .eq('id', proofId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (fetchError || !proof) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Proof not found or not owned by you' }) };
    }

    if (proof.file_deleted_at) {
      return { statusCode: 410, headers: CORS_HEADERS, body: JSON.stringify({ error: 'File already deleted' }) };
    }

    if (!proof.file_storage_path) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'No file attached to this proof' }) };
    }

    // Delete from storage
    const { error: storageError } = await supabase.storage
      .from('proof-files')
      .remove([proof.file_storage_path]);

    if (storageError) {
      console.error('[revoke-file] Storage error:', JSON.stringify(storageError));
      // Continue — mark as revoked anyway
    }

    // Mark as revoked + deleted
    const now = new Date().toISOString();
    const { error: updateError } = await supabase
      .from('proofs')
      .update({
        revoked_at: now,
        revoked_reason: reason || 'Sender revoked',
        file_deleted_at: now,
        file_storage_path: null
      })
      .eq('id', proofId);

    if (updateError) {
      console.error('[revoke-file] Update error:', JSON.stringify(updateError));
      throw new Error('Failed to revoke file');
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: true, revoked_at: now })
    };

  } catch (error) {
    console.error('[revoke-file] error:', error.message);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: `Revoke failed: ${error.message}` }) };
  }
};
