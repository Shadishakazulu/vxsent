// netlify/functions/auth-magic-link.js
// Production-grade: generates secure token, stores in Supabase users table, sends magic link via Resend

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

    // Generate secure token (64 hex chars)
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes

    // Upsert user in Supabase (create if not exists, update token if exists)
    const upsertRes = await fetch(
      `${supabaseUrl}/rest/v1/users?email=eq.${encodeURIComponent(email)}`,
      {
        method: 'GET',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const existingUsers = await upsertRes.json();

    if (existingUsers && existingUsers.length > 0) {
      // Update existing user with new token
      await fetch(
        `${supabaseUrl}/rest/v1/users?email=eq.${encodeURIComponent(email)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            magic_token: token,
            token_expires_at: expiresAt,
            updated_at: new Date().toISOString()
          })
        }
      );
    } else {
      // Create new user
      await fetch(
        `${supabaseUrl}/rest/v1/users`,
        {
          method: 'POST',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            email: email,
            magic_token: token,
            token_expires_at: expiresAt,
            plan: 'none',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
        }
      );
    }

    // Build magic link URL — auth-verify handles GET requests
    const magicLink = `${siteUrl}/api/auth/verify?token=${token}&email=${encodeURIComponent(email)}`;

    // Send email via Resend
    if (resendApiKey) {
      const emailHtml = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 500px; margin: 0 auto; padding: 40px 24px;">
          <div style="text-align: center; margin-bottom: 32px;">
            <span style="font-family: Impact, sans-serif; font-size: 28px; letter-spacing: 2px; color: #111;">● SENT.</span>
          </div>
          
          <h1 style="font-size: 22px; font-weight: 700; color: #111; text-align: center; margin-bottom: 12px;">Sign in to SENT.</h1>
          <p style="color: #374151; text-align: center; margin-bottom: 28px; line-height: 1.6;">Click the button below to sign in. This link expires in 15 minutes.</p>
          
          <div style="text-align: center; margin-bottom: 32px;">
            <a href="${magicLink}" style="display: inline-block; background: #00b356; color: #fff; padding: 14px 36px; border-radius: 4px; text-decoration: none; font-weight: 700; font-size: 16px; letter-spacing: 0.5px;">SIGN IN →</a>
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
          subject: 'Sign in to SENT.',
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

      console.log(`Magic link sent to ${email}`);
    } else {
      console.warn('RESEND_API_KEY not configured — magic link not sent');
      console.log(`Magic link for ${email}: ${magicLink}`);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        message: 'Magic link sent'
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
