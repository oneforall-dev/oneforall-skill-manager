# Reversible Coolify deployment — Director audit automation 1.1.0

## Images

- `ghcr.io/oneforall-dev/oneforall-director-api:audit-automation-1.1.0`
- `ghcr.io/oneforall-dev/oneforall-director-mcp:audit-automation-1.1.0`

The workflow also updates `latest`, but it no longer overwrites historical rollback tags.

## Rollback

Restore the currently deployed image tags for Director API and Director MCP in Coolify, then perform a rolling redeploy. The audit job files are additive under `DATA_DIR/audit-jobs`; the previous binaries ignore them, so no destructive data rollback is needed.

## Existing configuration used

- `OPENAI_API_KEY` already used by Director media transcription is reused for Auditor execution; do not create or rotate it.
- `PUBLISHER_MCP_URL` defaults to `https://social.ocloud.click/mcp`.
- `SOCIAL_MANAGER_MCP_URL` defaults to `https://social-manager.ocloud.click/mcp`.
- `AUDITOR_RECEIPT_HMAC_SECRET` is consumed only if already present. Do not copy, rotate or expose it during this deployment. Audit-required Publisher content blocks if it is absent.

Optional non-secret settings: `AUDITOR_MODEL`, `AUDITOR_MAX_ATTEMPTS`, `AUDITOR_RETRY_BASE_MS`, `AUDITOR_WORKER_INTERVAL_MS`, `AUDITOR_TIMEOUT_MS`, `AUDITOR_WEB_SEARCH`, `AUDITOR_IDENTITY`, `AUDITOR_RECEIPT_ISSUER`.

`AUDITOR_BACKFILL_READY` remains false by default to prevent a deployment from auditing every historical pending item. The specified pre-existing ITEM_ID is dispatched idempotently after deployment through `dispatch_audit_job`; future transitions dispatch automatically.

## Smoke test (no Instagram side effects)

1. Verify both `/health` endpoints report version `1.1.0`.
2. Rediscover Director tools and confirm `get_audit_job`, `dispatch_audit_job`, and `retry_audit_job`.
3. Dispatch only `WM-NEWS-EDITS-CAROUSELS-20261008`, Director version 2.
4. Read the job until `COMPLETED` or a real `BLOCKED` reason appears.
5. Read Director, Publisher and Social Manager state. Do not approve, schedule or publish.
6. Compare scheduled/published Publisher records before and after; they must be unchanged.
