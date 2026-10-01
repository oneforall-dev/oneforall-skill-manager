# Auth0 setup for Oneforall Social Manager

This document configures OAuth for `https://social-manager.ocloud.click` without committing secrets.

## 1. Auth0 API

Create or verify an Auth0 API with:

- Identifier / Audience: `https://social-manager.ocloud.click`
- Signing algorithm: RS256

Permissions / scopes:

- `social.read`
- `social.write`
- `social.publish`
- `social.admin`

Enable RBAC for the API. Enable **Add Permissions in the Access Token** so the backend can read the `permissions` array. The backend also accepts scopes from the standard `scope` claim.

## 2. Auth0 Post Login Action

Use `auth0/post-login.js` as the Action code. Deploy it and add it to the Login Flow.

The Action adds this access-token claim:

`https://oneforall.ocloud.click/email`

The value is the normalized email of the authenticated user.

## 3. Allowed users

The backend additionally checks the email allowlist. Configure `ALLOWED_EMAILS` in Coolify, for example:

`wilson.meza@gmail.com,agency.oneforall@gmail.com`

Do not put credentials, tokens, client secrets or refresh tokens in this repository.

## 4. Coolify environment

Keep OAuth disabled while testing the rest of the backend:

`AUTH_ENABLED=false`

Prepare these variables before enabling it:

- `AUTH_ISSUER` = exact issuer advertised by Auth0, including trailing slash when applicable
- `AUTH_AUDIENCE=https://social-manager.ocloud.click`
- `AUTH_JWKS_URI` = Auth0 JWKS endpoint
- `AUTH_EMAIL_CLAIM=https://oneforall.ocloud.click/email`
- `MCP_RESOURCE_URL=https://social-manager.ocloud.click`
- `ALLOWED_EMAILS` = comma-separated allowlist

When the new backend version is deployed, `GET /health` exposes only non-secret OAuth diagnostics: whether issuer/audience/JWKS are configured, the resource, the configured email-claim name, allowed-email count and supported scopes.

## 5. Activation sequence

1. Leave `AUTH_ENABLED=false` and verify Social Manager MCP reads/writes work.
2. Configure the Auth0 API, permissions and Login Flow Action.
3. Configure the Coolify variables above.
4. Redeploy while `AUTH_ENABLED=false` and inspect `/health` diagnostics.
5. Set `AUTH_ENABLED=true` and redeploy.
6. Reconnect Oneforall Social Manager in ChatGPT so a fresh access token is issued.
7. Verify `get_social_dashboard` (`social.read`).
8. Verify one safe ledger write (`social.write`).
9. Verify an admin-only operation only when needed (`social.admin`).

## 6. Diagnosing a 401

The backend validates:

1. JWT signature via `AUTH_JWKS_URI`
2. exact issuer via `AUTH_ISSUER`
3. exact audience via `AUTH_AUDIENCE`
4. expiry / JWT validity
5. email from the configured namespaced claim (with standard `email` / `upn` fallbacks)
6. email membership in `ALLOWED_EMAILS`
7. required tool scopes

Backend v0.6.1 logs a safe OAuth failure reason to service logs without logging the Bearer token. Use the Coolify logs after a failed request to distinguish audience, issuer, signature, expiry and allowlist problems.

Do not paste access tokens, cookies, Auth0 secrets or Coolify secrets into ChatGPT.
