// netlify/functions/auth-magic-link.js
// Production-grade: generates secure token, stores in Supabase users table, sends magic link via Resend
// + Optional promo code: grants Solo trial when a valid code is supplied

const crypto = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    let body;
    try {
      body = JSON.parse(event.body);
    } catch {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid request body' })
      };
    }

    const { email } = body;
    const promoCodeRaw = (body.promoCode || '').trim();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Valid email required' })
      };
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const resendApiKey = process.env.RESEND_API_KEY;
    const siteUrl = process.env.SITE_URL || 'https://vxsent.com';

    if (!supabaseUrl || !supabaseKey) {
      console.error('Supabase credentials not configured');
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Service unavailable' })
      };
    }

    const sb = (path, opts = {}) => fetch(`${supabaseUrl}/rest/v1/${path}`, {
      ...opts,
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {})
      }
    });

    // ============================================================
    // PROMO CODE VALIDATION (only if a code was supplied)
    // Decision (a): if they typed a code and it's bad, block with a clear error.
    // ============================================================
    let promoGrant = null; // { code, trial_days } when valid

    if (promoCodeRaw) {
      const codeUpper = promoCodeRaw.toUpperCase();

      // Look up the code (case-insensitive)
      const codeRes = await sb(`promo_codes?code=eq.${encodeURIComponent(codeUpper)}&select=*`);
      const codeRows = await codeRes.json();
      const promo = Array.isArray(codeRows) && codeRows.length > 0 ? codeRows[0] : null;

      if (!promo) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'That promo code isn\u2019t valid.' })
        };
      }
      if (!promo.active) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'That promo code is no longer active.' })
        };
      }
      if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'That promo code has expired.' })
        };
      }
      if (promo.max_uses != null && promo.times_used >= promo.max_uses) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'That promo code has reached its limit.' })
        };
      }

      // One redemption per email per code
      const redRes = await sb(`promo_redemptions?code=eq.${encodeURIComponent(promo.code)}&email=eq.${encodeURIComponent(email)}&select=id`);
      const redRows = await redRes.json();
      if (Array.isArray(redRows) && redRows.length > 0) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'You\u2019ve already used this promo code.' })
        };
      }

      promoGrant = { code: promo.code, plan: promo.plan_granted || 'solo', trial_days: promo.trial_days || 7 };
    }

    // Generate secure token (64 hex chars)
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes

    // Build the user patch/insert payload. Add plan fields ONLY if a valid promo was supplied.
    const planFields = promoGrant
      ? {
          plan: promoGrant.plan,
          plan_expires_at: new Date(Date.now() + promoGrant.trial_days * 24 * 60 * 60 * 1000).toISOString()
        }
      : {};

    // Upsert user (create if not exists, update token if exists)
    const upsertRes = await sb(`users?email=eq.${encodeURIComponent(email)}`, { method: 'GET' });
    const existingUsers = await upsertRes.json();

    if (existingUsers && existingUsers.length > 0) {
      await sb(`users?email=eq.${encodeURIComponent(email)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          magic_token: token,
          token_expires_at: expiresAt,
          updated_at: new Date().toISOString(),
          ...planFields
        })
      });
    } else {
      await sb('users', {
        method: 'POST',
        body: JSON.stringify({
          email: email,
          magic_token: token,
          token_expires_at: expiresAt,
          plan: promoGrant ? promoGrant.plan : 'none',
          ...(promoGrant ? { plan_expires_at: planFields.plan_expires_at } : {}),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
      });
    }

    // ============================================================
    // RECORD REDEMPTION + INCREMENT USAGE (only after user upsert succeeds)
    // ============================================================
    if (promoGrant) {
      // Log redemption (unique constraint on (code,email) is the backstop against double-use)
      await sb('promo_redemptions', {
        method: 'POST',
        body: JSON.stringify({
          code: promoGrant.code,
          email: email,
          trial_days: promoGrant.trial_days,
          redeemed_at: new Date().toISOString()
        })
      });

      // Increment times_used. Re-read current value then patch (no race-proofing needed at this scale).
      const cRes = await sb(`promo_codes?code=eq.${encodeURIComponent(promoGrant.code)}&select=times_used`);
      const cRows = await cRes.json();
      const current = Array.isArray(cRows) && cRows.length > 0 ? (cRows[0].times_used || 0) : 0;
      await sb(`promo_codes?code=eq.${encodeURIComponent(promoGrant.code)}`, {
        method: 'PATCH',
        body: JSON.stringify({ times_used: current + 1 })
      });
    }

    // Build magic link URL — auth-verify handles GET requests
    const magicLink = `${siteUrl}/api/auth/verify?token=${token}&email=${encodeURIComponent(email)}`;

    // Send email via Resend
    if (resendApiKey) {
      const trialBanner = promoGrant
        ? `<div style="background:#e6f7ee;border:1px solid rgba(0,179,86,0.25);border-radius:6px;padding:14px 18px;margin-bottom:24px;text-align:center"><div style="font-size:13px;color:#009347;font-weight:700">\uD83C\uDF89 Your ${promoGrant.trial_days}-day Solo trial is ready</div><div style="font-size:12px;color:#374151;margin-top:4px">Sign in below to start sending gated, proof-backed files.</div></div>`
        : '';

      const emailHtml = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 500px; margin: 0 auto; padding: 40px 24px;">
          <div style="text-align: center; margin-bottom: 32px;">
            <span style="font-family: Impact, sans-serif; font-size: 28px; letter-spacing: 2px; color: #111;">\u25CF SENT.</span>
          </div>
          ${trialBanner}
          <h1 style="font-size: 22px; font-weight: 700; color: #111; text-align: center; margin-bottom: 12px;">Sign in to SENT.</h1>
          <p style="color: #374151; text-align: center; margin-bottom: 28px; line-height: 1.6;">Click the button below to sign in. This link expires in 15 minutes.</p>

          <div style="text-align: center; margin-bottom: 32px;">
            <a href="${magicLink}" style="display: inline-block; background: #00b356; color: #fff; padding: 14px 36px; border-radius: 4px; text-decoration: none; font-weight: 700; font-size: 16px; letter-spacing: 0.5px;">SIGN IN \u2192</a>
          </div>

          <p style="color: #9ca3af; font-size: 12px; text-align: center; line-height: 1.5;">
            If you didn't request this, you can safely ignore this email.<br>
            <a href="https://vxsent.com" style="color: #00b356;">vxsent.com</a>
          </p>
        </div>
      `;

      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'SENT. <noreply@vxsent.com>',
          to: email,
          subject: promoGrant ? 'Your SENT. trial is ready — sign in' : 'Sign in to SENT.',
          html: emailHtml
        })
      });

      if (!emailRes.ok) {
        const errBody = await emailRes.text();
        console.error(`Failed to send magic link email: ${emailRes.status} ${errBody}`);
        return {
          statusCode: 500,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Failed to send email. Please try again.' })
        };
      }

      console.log(`Magic link sent to ${email}${promoGrant ? ` (promo: ${promoGrant.code})` : ''}`);
    } else {
      console.warn('RESEND_API_KEY not configured — magic link not sent');
      console.log(`Magic link for ${email}: ${magicLink}`);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        message: 'Magic link sent',
        promoApplied: !!promoGrant,
        trialDays: promoGrant ? promoGrant.trial_days : null
      })
    };
  } catch (error) {
    console.error('auth-magic-link error:', error.message, error.stack);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to send magic link. Please try again.' })
    };
  }
};
