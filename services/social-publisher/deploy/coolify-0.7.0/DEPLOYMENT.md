# Coolify deployment plan — Social Publisher 0.7.0

All mandatory checks in `TEST-RESULTS.md` passed. Version `0.7.0` was deployed by rolling update on 2026-10-13 and remains reversible to `0.6.4`.

## Current rollback target

- Version: `0.6.4`
- Previously deployed bundle URL: `https://pub-90b7b83c202c4e9a820bb7a14c3bffb7.r2.dev/clients/thespiraluniverse/2026-10-02/1d95491a-964e-48a4-9475-2a44ecfff19d.tgz`
- Migration 007 is additive. Version 0.6.4 ignores the new column and tables, so rolling back the application does not require a destructive database rollback.

## Required new environment variables

- `AUDITOR_RECEIPT_HMAC_SECRET`: at least 32 random characters, shared only with the trusted Auditor signing service.
- `AUDITOR_ALLOWED_ISSUERS`: comma-separated allowlist; initial value `oneforall-auditor`.
- Optional: `AUDITOR_RECEIPT_MAX_AGE_MS` and `AUDITOR_RECEIPT_FUTURE_SKEW_MS`.

Never place the secret in this bundle, Dockerfile, logs, ChatGPT, or the deployment report.

## Staged deployment

1. Upload the generated `oneforall-social-publisher-v21-0.7.0.tgz` to the private deployment asset location and verify its SHA-256 from `SHA256SUMS.txt`.
2. Set Coolify build argument `PUBLISHER_BUNDLE_URL` to that exact asset URL.
3. Keep the existing production variables and add the Auditor variables above.
4. Keep the existing Coolify pre-deployment command, but also start the new image with `npm run migrate && node dist/server.js`. Coolify runs pre-deployment inside the old container, which cannot see migration 007; the new image must apply its own additive migration before opening the server.
5. Use a rolling deployment; do not stop the 0.6.4 container first.
6. Verify `/live`, `/ready`, MCP initialization, tool discovery, read-only list calls, and that `register_audit_receipt` is present.
7. Perform no publish or schedule call during the smoke test.

## Verified deployment result

- Deployment ID: `i7uiwb1zszs4h6tx2hqlz4h6`.
- Rolling update: PASS.
- New container healthcheck: PASS on first attempt.
- Migration 007: PASS in the new container before server start.
- Runtime: `Oneforall Social Publisher 0.7.0 listening on :8787`.
- The older container was removed only after the new container became healthy.
- A first build was intentionally cancelled before cutover when it was observed that Coolify's pre-deployment command ran in 0.6.4; production continued serving 0.6.4 during that cancelled build.

## Rollback

1. Restore the previous 0.6.4 bundle URL in the active Coolify Dockerfile/configuration.
2. Redeploy with rolling update.
3. Verify `/health` reports `0.6.4` and read-only MCP calls succeed.
4. Leave migration 007 in place. It is additive and deleting its evidence tables would make rollback destructive.
5. Preserve any `publish_operations` in `unknown` or `platform_pending`; reconcile them before any future publication attempt.

