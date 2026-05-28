// netlify/functions/delete-expired-files.js
// Scheduled function — runs every 5 minutes.
// Deletes files from storage where:
//   - deletion_scheduled_at is past (30 min after download)
//   - OR file_expires_at is past (7 days after upload, never downloaded)
//   - OR revoked_at is set
// Marks file_deleted_at on the proof record. Proof itself stays forever.

import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

export const handler = async () => {
  console.log('[delete-expired-files] Starting cleanup run');
  const supabase = getSupabase();
  const now = new Date().toISOString();
  const stats = { checked: 0, deleted: 0, errors: 0 };

  try {
    // Find proofs with files that need deletion
    const { data: expiredProofs, error: queryError } = await supabase
      .from('proofs')
      .select('id, file_storage_path, deletion_scheduled_at, file_expires_at, revoked_at, file_name')
      .not('file_storage_path', 'is', null)
      .is('file_deleted_at', null)
      .or(`deletion_scheduled_at.lt.${now},file_expires_at.lt.${now},revoked_at.not.is.null`)
      .limit(100);

    if (queryError) {
      console.error('[delete-expired-files] Query error:', JSON.stringify(queryError));
      return { statusCode: 500, body: JSON.stringify({ error: 'Query failed' }) };
    }

    stats.checked = (expiredProofs || []).length;
    console.log(`[delete-expired-files] Found ${stats.checked} files to delete`);

    for (const proof of expiredProofs || []) {
      try {
        // Delete from Supabase Storage
        const { error: deleteError } = await supabase.storage
          .from('proof-files')
          .remove([proof.file_storage_path]);

        if (deleteError) {
          console.error(`[delete-expired-files] Storage delete failed for ${proof.id}:`, JSON.stringify(deleteError));
          stats.errors++;
          continue;
        }

        // Mark as deleted in DB (keep storage_path for audit trail in another column if needed)
        const { error: updateError } = await supabase
          .from('proofs')
          .update({
            file_deleted_at: now,
            file_storage_path: null // Clear the path since file is gone
          })
          .eq('id', proof.id);

        if (updateError) {
          console.error(`[delete-expired-files] DB update failed for ${proof.id}:`, JSON.stringify(updateError));
          stats.errors++;
          continue;
        }

        stats.deleted++;
        console.log(`[delete-expired-files] Deleted file for proof ${proof.id} (${proof.file_name})`);

      } catch (err) {
        console.error(`[delete-expired-files] Error processing ${proof.id}:`, err.message);
        stats.errors++;
      }
    }

    console.log('[delete-expired-files] Cleanup complete:', JSON.stringify(stats));
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, ...stats })
    };

  } catch (error) {
    console.error('[delete-expired-files] Fatal error:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
