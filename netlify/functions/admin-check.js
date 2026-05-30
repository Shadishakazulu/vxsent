// netlify/functions/admin-check.js
// Lightweight authorization probe used by the /admin page on load.
// Returns 200 { admin: true } only for an allowlisted, signed-in operator.
// Non-admins get the same 401/403 as every other admin endpoint, so hitting
// this directly leaks nothing.

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

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ admin: true, email: gate.user.email })
  };
};
