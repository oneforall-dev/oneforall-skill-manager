# Oneforall Social Publisher 0.8.0

Multi-client Instagram publishing MCP for ChatGPT/Work with Meta OAuth, Cloudflare R2 storage, scheduling, account routing and audit logs.

## Audit, owner authorization and resilience in 0.8.0
- New or materially changed content requires either an authenticated Oneforall Auditor PASS receipt or an exact, explicit `OWNER_OVERRIDE` before approval, scheduling, worker execution or immediate publication.
- `OWNER_OVERRIDE` is stored separately from Auditor evidence and binds owner, ITEM_ID, version, account, full content snapshot/hash, action and authorization time. Scheduling also binds the exact timestamp/timezone.
- Content, asset order, copy, account, version or schedule changes make a previous override unusable.
- Missing Auditor execution changes from `AUDIT_PENDING` to explicit `AUDITOR_NOT_EXECUTED` after a bounded timeout; Publisher never invents PASS.
- Receipts use HMAC-SHA256 (`v1=<hex>`) with a server-only secret and issuer allowlist, and bind the exact client, ITEM_ID, version and content fingerprint.
- Existing rows are grandfathered without modifying their historical status, schedule, approval or publication evidence. A material edit enables the new gate.
- Durable `publish_operations` keys prevent the same ITEM_ID/version/destination from being submitted twice.
- Ambiguous `media_publish` outcomes remain blocked for reconciliation instead of being marked retryable.
- The scheduler no longer preclaims a row as publishing; Publisher owns the atomic durable claim.
- The database watchdog uses coordinated shutdown and waits for active scheduler work before closing the pool.
- AWS S3 packages are pinned together, and typed R2 PUT/HEAD calls are covered by a local integration test.

## Persistent content items (V0.5)
- Every new content unit is stored under a client-scoped `ITEM_ID`.
- The record includes destination account, format, ordered assets, full caption, lifecycle state, internal post ID and Instagram media ID after publication.
- Approval is bound to an exact `content_version` and SHA-256 snapshot of all publishable fields.
- Changing copy, account, format, asset membership or asset order increments the version and invalidates approval.
- `list_content_items(readiness=approved_unpublished)` returns the ready-to-publish queue.

## What V2.1 adds
- Instagram OAuth onboarding per Oneforall client (`get_instagram_connect_url`).
- One-time OAuth state tied to the selected client; 10-minute expiry and single use.
- Short-lived → long-lived Instagram token exchange; encrypted token persistence.
- Automatic refresh of OAuth-connected long-lived tokens before expiry.
- Cloudflare R2/S3-compatible storage.
- Presigned 15-minute PUT uploads (`create_asset_upload` → `finalize_asset_upload`).
- Server-side copy of retrievable generated/external assets into R2 (`import_asset_from_url`).
- R2 object verification with `HeadObject` before asset registration.
- Existing V2 multi-client drafts, immediate publish, scheduler, logs, image/carousel/Reel flows.

## Core flow
1. `create_client`
2. `get_instagram_connect_url`
3. User opens the returned URL and authorizes Instagram.
4. Instagram redirects to `/oauth/instagram/callback`; the service exchanges/extends the token, fetches profile metadata, encrypts the token and connects it to that client.
5. Assets enter R2 using either:
   - `create_asset_upload` + direct PUT + `finalize_asset_upload`, or
   - `import_asset_from_url` for an existing HTTPS media URL.
6. `create_post_draft`
7. `get_post` to show exact approval summary.
8. `publish_post_now(confirm=true)` or `schedule_post(confirm=true)` only after explicit approval.

## Requirements
- Node.js 24+
- PostgreSQL 15+
- Meta app configured for Instagram API with Instagram Login.
- Professional Instagram accounts (Business/Creator) supported by the configured Meta app.
- Cloudflare R2 bucket with S3 API credentials.
- Public R2 custom domain/bucket URL so Instagram can fetch final media URLs.
- Public HTTPS service domain for OAuth callback and MCP.

## Instagram environment
Set the callback in Meta to exactly the same URL as `INSTAGRAM_REDIRECT_URI`, for example:

```text
https://social.oneforall.ocloud.click/oauth/instagram/callback
```

The implementation requests:

```text
instagram_business_basic
instagram_business_content_publish
```

The authorize/token endpoints are environment-configurable so they can be changed without rebuilding if Meta changes routing.

## R2 setup
Create an R2 bucket and API credentials. Attach a public custom domain, for example:

```text
https://media.oneforall.ocloud.click
```

Set `R2_PUBLIC_BASE_URL` to that origin. The S3 endpoint is derived from `R2_ACCOUNT_ID` and uses region `auto`.

For browser/direct uploads, configure bucket CORS to allow the origin performing the PUT and the `Content-Type` header. Presigned upload URLs expire after 15 minutes.

## Environment
Copy `.env.example` to `.env` and fill secrets. Generate the token encryption key with:

```bash
openssl rand -base64 32
```

Never expose `INSTAGRAM_APP_SECRET`, R2 secret keys, or `TOKEN_ENCRYPTION_KEY_BASE64` to ChatGPT tools.

Auditor gate variables:

```text
AUDITOR_RECEIPT_HMAC_SECRET=<at least 32 random characters>
AUDITOR_ALLOWED_ISSUERS=oneforall-auditor
AUDITOR_RECEIPT_MAX_AGE_MS=604800000
AUDITOR_RECEIPT_FUTURE_SKEW_MS=300000
AUDITOR_EXECUTION_TIMEOUT_MS=900000
```

The Auditor service signs the canonical JSON receipt defined in `src/audit.ts`. Publisher only verifies signatures; it never exposes a signing action. `register_owner_override` is a distinct first-party owner decision and never writes to `audit_receipts`.

## Database migrations
`npm run migrate` applies every `.sql` file in `migrations/` in lexical order. Migrations are written to be idempotent.

## Local / Coolify
```bash
npm install
npm run migrate
npm run build
npm run test:unit
npm run test:integration
npm start
```

Endpoints:
- `GET /health`
- `POST /mcp`
- `GET /oauth/instagram/callback`

For Coolify:
1. Deploy PostgreSQL.
2. Deploy this project from the Dockerfile.
3. Add all production environment variables.
4. Run `npm run migrate` once.
5. Bind a public HTTPS domain to the app.
6. Add that exact OAuth callback URL in Meta.
7. Connect `https://<domain>/mcp` to the Oneforall Social Publisher plugin.

## New MCP tools in V2.1
- `get_instagram_connect_url`
- `refresh_instagram_token`
- `create_asset_upload`
- `finalize_asset_upload`
- `import_asset_from_url`

Existing tools remain available for clients, accounts, asset listing, drafts, publishing, scheduling, cancellation and audit logs.

## Security decisions
- OAuth `state` is 256-bit random, stored only as SHA-256, expires after 10 minutes and is deleted atomically when consumed.
- Instagram tokens are AES-256-GCM encrypted at rest.
- OAuth app secret and R2 secrets never appear in MCP outputs.
- Publishing and scheduling require explicit `confirm=true` after approval.
- The destination client/account is included in post inspection before publish.
- Presigned uploads are scoped to one object, one content type and 15 minutes.

## Generated ChatGPT assets
If ChatGPT/Work provides a retrievable HTTPS URL, `import_asset_from_url` can copy it directly into R2. If the runtime exposes raw file bytes instead, use `create_asset_upload` and upload those bytes to its presigned `upload_url`, then call `finalize_asset_upload`. This keeps the publishing layer independent of temporary ChatGPT attachment URLs.
