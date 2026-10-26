const required = [
  'AUTH_ISSUER',
  'AUTH_AUDIENCE',
  'AUTH_JWKS_URI',
  'AUTH_EMAIL_CLAIM',
  'MCP_RESOURCE_URL',
  'ALLOWED_EMAILS'
];

const expected = {
  AUTH_AUDIENCE: 'https://social-manager.ocloud.click',
  AUTH_EMAIL_CLAIM: 'https://oneforall.ocloud.click/email',
  MCP_RESOURCE_URL: 'https://social-manager.ocloud.click'
};

let ok = true;
const result = {};

for (const key of required) {
  const value = String(process.env[key] ?? '').trim();
  const configured = Boolean(value);
  const exact = expected[key] ? value.replace(/\/$/, '') === expected[key].replace(/\/$/, '') : null;
  if (!configured || exact === false) ok = false;
  result[key] = exact === null ? { configured } : { configured, expected_match: exact };
}

const issuer = String(process.env.AUTH_ISSUER ?? '');
const jwks = String(process.env.AUTH_JWKS_URI ?? '');
result.AUTH_ISSUER.trailing_slash = issuer ? issuer.endsWith('/') : false;
result.AUTH_JWKS_URI.looks_like_jwks = /\/\.well-known\/jwks\.json(?:$|\?)/.test(jwks);
if (jwks && !result.AUTH_JWKS_URI.looks_like_jwks) ok = false;

const allowedCount = String(process.env.ALLOWED_EMAILS ?? '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean).length;
result.ALLOWED_EMAILS = { configured: allowedCount > 0, count: allowedCount };
if (!allowedCount) ok = false;

console.log(JSON.stringify({
  ok,
  auth_enabled: /^(1|true|yes)$/i.test(process.env.AUTH_ENABLED ?? 'false'),
  checks: result
}, null, 2));

process.exitCode = ok ? 0 : 1;
