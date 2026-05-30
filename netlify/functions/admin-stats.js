// netlify/functions/admin-stats.js
// Read-only platform analytics for the operator. Every figure is a real count or
// sum computed from stored rows; anything that cannot be derived honestly is
// returned as null and rendered "n/a" by the page (never a fabricated number).
//
// No sensitive values (session tokens, magic-link tokens, Stripe identifiers,
// payment credentials) are selected or returned.

const { requireAdmin } = require('./_admin-auth');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Cookie' } };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const gate = await requireAdmin(event);
  if (!gate.ok) return gate.response;
  const supabase = gate.supabase;

  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const nowIso = now.toISOString();
    const todayIso = startOfToday.toISOString();
    const weekIso = weekAgo.toISOString();

    // Helper: exact head-count with optional filters applied via a builder fn.
    const countTransfers = (apply) => {
      let q = supabase.from('transfers').select('id', { count: 'exact', head: true });
      if (apply) q = apply(q);
      return q;
    };
    const countProofs = (apply) => {
      let q = supabase.from('proofs').select('id', { count: 'exact', head: true });
      if (apply) q = apply(q);
      return q;
    };
    const countUsers = (apply) => {
      let q = supabase.from('users').select('id', { count: 'exact', head: true });
      if (apply) q = apply(q);
      return q;
    };

    // ── Transfers ──────────────────────────────────────────────────────────
    const [
      tfTotal, tfToday, tfWeek, tfSealed, tfAck,
    ] = await Promise.all([
      countTransfers(),
      countTransfers(q => q.gte('created_at', todayIso)),
      countTransfers(q => q.gte('created_at', weekIso)),
      countTransfers(q => q.eq('is_valid', true)),
      countTransfers(q => q.eq('buyer_confirmed', true)),
    ]);

    const transfersTotal = tfTotal.count ?? 0;
    const transfersToday = tfToday.count ?? 0;
    const transfersWeek = tfWeek.count ?? 0;
    const transfersSealed = tfSealed.count ?? 0;
    const transfersAck = tfAck.count ?? 0;
    // Acknowledge rate = share of SEALED transfers a buyer has confirmed.
    // Undefined (n/a) when nothing has been sealed yet.
    const ackRate = transfersSealed > 0
      ? Math.round((transfersAck / transfersSealed) * 1000) / 10
      : null;

    // ── Proofs (delivery proofs that have been sealed) ─────────────────────
    const [pfTotal, pfWeek] = await Promise.all([
      countProofs(q => q.eq('is_valid', true)),
      countProofs(q => q.eq('is_valid', true).gte('created_at', weekIso)),
    ]);
    const proofsTotal = pfTotal.count ?? 0;
    const proofsWeek = pfWeek.count ?? 0;

    // ── Users ──────────────────────────────────────────────────────────────
    const [usTotal, usWeek, usSolo] = await Promise.all([
      countUsers(),
      countUsers(q => q.gte('created_at', weekIso)),
      // Active Solo subscribers: plan 'solo' AND not expired.
      countUsers(q => q.eq('plan', 'solo').gt('plan_expires_at', nowIso)),
    ]);
    const usersTotal = usTotal.count ?? 0;
    const usersWeek = usWeek.count ?? 0;
    const activeSolo = usSolo.count ?? 0;
    const payPerUse = Math.max(0, usersTotal - activeSolo);

    // ── Revenue (only payments actually collected) ─────────────────────────
    // Sum succeeded payment rows in JS — only amount + type are selected, never
    // any Stripe identifier. Subscription (invoice) revenue is NOT written to the
    // payments table, so subscription dollars are reported as n/a (null).
    let dayPassCents = 0;
    let transferCents = 0;
    let revenueComputable = true;
    const { data: payments, error: payErr } = await supabase
      .from('payments')
      .select('amount, payment_type, status')
      .eq('status', 'succeeded')
      .limit(50000);
    if (payErr) {
      revenueComputable = false;
    } else {
      for (const p of payments || []) {
        const cents = Number(p.amount) || 0;
        if (p.payment_type === 'day_pass') dayPassCents += cents;
        else if (p.payment_type === 'single_transfer') transferCents += cents;
      }
    }

    const toDollars = (cents) => Math.round(cents) / 100;
    const revenue = revenueComputable ? {
      dayPass: toDollars(dayPassCents),
      payPerTransfer: toDollars(transferCents),
      combined: toDollars(dayPassCents + transferCents),
      subscription: null,            // n/a — invoice payments are not recorded
      activeSubscriptions: activeSolo
    } : {
      dayPass: null,
      payPerTransfer: null,
      combined: null,
      subscription: null,
      activeSubscriptions: activeSolo
    };

    // ── Recent activity feed (newest transfers + proofs, interleaved) ──────
    const FEED_EACH = 15;
    const [recentTransfersRes, recentProofsRes] = await Promise.all([
      supabase.from('transfers')
        .select('id, item_title, seller_email, buyer_email, status, is_valid, buyer_confirmed, created_at')
        .order('created_at', { ascending: false })
        .limit(FEED_EACH),
      supabase.from('proofs')
        .select('id, file_name, user_email, recipient_email, recipient_confirmed, is_valid, created_at')
        .eq('is_valid', true)
        .order('created_at', { ascending: false })
        .limit(FEED_EACH),
    ]);

    const feed = [];
    for (const t of (recentTransfersRes.data || [])) {
      feed.push({
        type: 'transfer',
        id: t.id,
        name: t.item_title || '(untitled)',
        from: t.seller_email || '',
        to: t.buyer_email || '',
        status: t.buyer_confirmed ? 'acknowledged' : (t.is_valid ? 'sealed' : (t.status || 'pending')),
        at: t.created_at
      });
    }
    for (const p of (recentProofsRes.data || [])) {
      feed.push({
        type: 'proof',
        id: p.id,
        name: p.file_name || '(file)',
        from: p.user_email || '',
        to: p.recipient_email || '',
        status: p.recipient_confirmed ? 'acknowledged' : 'sealed',
        at: p.created_at
      });
    }
    feed.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    const activity = feed.slice(0, 20);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        generatedAt: nowIso,
        transfers: {
          total: transfersTotal,
          today: transfersToday,
          week: transfersWeek,
          sealed: transfersSealed,
          acknowledged: transfersAck,
          ackRate // null => n/a
        },
        proofs: {
          total: proofsTotal,
          week: proofsWeek
        },
        users: {
          total: usersTotal,
          week: usersWeek,
          activeSolo,
          payPerUse
        },
        revenue,
        activity
      })
    };
  } catch (error) {
    console.error('[admin-stats] error:', error.message);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Failed to load stats' }) };
  }
};
