// netlify/functions/_vxpay-common.js
// Shared helpers for the VX Pay (Escrowed Payment Agreement) endpoints.
//
// Persistence for VX Pay lives in the Netlify Database (managed Postgres),
// reached via the native @netlify/database driver. Authentication still uses
// the existing Supabase `users` table, so session verification continues to
// read from Supabase while agreement rows are stored on the Netlify Database.

import { getDatabase, MissingDatabaseConnectionError } from '@netlify/database';
import { createClient } from '@supabase/supabase-js';

// Netlify Database handle — connection is configured automatically from the
// site's provisioned database, no connection string needed.
export function getDb() {
  try {
    return getDatabase();
  } catch (error) {
    if (error instanceof MissingDatabaseConnectionError || error?.name === 'MissingDatabaseConnectionError') {
      throw new Error('VX Pay database is not connected to this deploy context. Enable Netlify Database for this site and redeploy.');
    }
    throw error;
  }
}

// Supabase is used only for auth (the `users` table).
export function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

export function getSessionToken(event) {
  const cookie = event.headers.cookie || event.headers.Cookie || '';
  const m1 = cookie.match(/vxsent_session=([^;]+)/);
  if (m1) return m1[1];
  const m2 = cookie.match(/session_token=([^;]+)/);
  if (m2) return m2[1];
  return null;
}

export async function verifySession(event) {
  const token = getSessionToken(event);
  if (!token) return null;
  const supabase = getSupabase();
  const now = new Date().toISOString();
  let { data: user } = await supabase
    .from('users').select('id, email, plan, plan_expires_at')
    .eq('session_token', token).gt('session_expires_at', now).single();
  if (user) return user;
  const { data: user2 } = await supabase
    .from('users').select('id, email, plan, plan_expires_at')
    .eq('magic_token', token).gt('magic_token_expires', now).single();
  return user2 || null;
}

export const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cookie',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Credentials': 'true'
};
