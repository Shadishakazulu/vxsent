// netlify/functions/get-transfer.js
// Public read for a transfer + its evidence. Mirrors get-proof.js.
// Used by the buyer acknowledgment page and the public verify page.

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };

  let transferId = (event.queryStringParameters && event.queryStringParameters.id)
    || event.path.split('/').pop();
  if (transferId) transferId = decodeURIComponent(transferId).trim();

  if (!transferId || !transferId.startsWith('SENT-TX-')) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid Transfer ID required', received: transferId }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: transfer, error } = await supabase
      .from('transfers').select('*').eq('id', transferId).maybeSingle();
    if (error) {
      console.error('[get-transfer] DB error:', JSON.stringify(error));
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Database error' }) };
    }
    if (!transfer) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Transfer not found' }) };

    // Evidence rows
    const { data: evidence } = await supabase
      .from('transfer_evidence').select('*').eq('transfer_id', transferId).order('sort_order', { ascending: true });

    // Generate short-lived signed URLs so the verify/ack page can show photos/docs
    const evidenceOut = [];
    for (const ev of (evidence || [])) {
      let viewUrl = null;
      try {
        const { data: signed } = await supabase.storage
          .from('transfer-evidence')
          .createSignedUrl(ev.storage_path, 600); // 10 min
        viewUrl = signed ? signed.signedUrl : null;
      } catch (e) { /* leave null */ }
      evidenceOut.push({
        fileName: ev.file_name,
        fileHash: ev.file_hash,
        fileMimeType: ev.file_mime_type,
        fileSize: ev.file_size,
        viewUrl
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ transfer, evidence: evidenceOut })
    };
  } catch (err) {
    console.error('[get-transfer] error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
