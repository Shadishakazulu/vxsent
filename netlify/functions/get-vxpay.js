// netlify/functions/get-vxpay.js
// Public read of a VX Pay agreement for the verification page. Returns the
// sealed proof fields + lifecycle. Mirrors get-transfer.js.

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  const id = (event.queryStringParameters && event.queryStringParameters.id) || '';
  if (!id) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing id' }) };
  try {
    const supabase = getSupabase();
    const { data: a, error } = await supabase.from('vxpay_agreements').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!a) return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
    const { data: evidence } = await supabase.from('vxpay_evidence')
      .select('file_name, file_hash, file_size, phase, uploaded_at').eq('agreement_id', id).order('sort_order');
    // never expose internal user_id / ips to the public verify surface
    const { user_id, buyer_ack_ip, ...pub } = a;
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ agreement: pub, evidence: evidence || [] }) };
  } catch (err) {
    console.error('[get-vxpay]', err);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
}
