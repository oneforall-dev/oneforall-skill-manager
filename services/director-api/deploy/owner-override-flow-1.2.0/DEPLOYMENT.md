# Reversible deployment — Director 1.2.0

## Scope

- Disable Director's automatic Auditor worker and all server-side Auditor dispatch/retry execution.
- Record `AUDITOR_NOT_EXECUTED` for each new exact version entering `READY_FOR_AUDIT`.
- Preserve all historical audit job files and expose them read-only.
- Keep real external Auditor results valid when they are recorded.
- Keep Publisher's existing exact `OWNER_OVERRIDE` route unchanged: it remains independent from `AUDITOR_PASS` and still binds owner, ITEM_ID, version, content hash, account, action and authorization time.

The optional `OPENAI_API_KEY` use in Director media transcription is outside the publication authorization flow and is unchanged. Publication and audit-state transitions do not read that variable.

## Images

- `ghcr.io/oneforall-dev/oneforall-director-api:owner-override-flow-1.2.0`
- `ghcr.io/oneforall-dev/oneforall-director-mcp:owner-override-flow-1.2.0`

## Deployment order

1. Record current Director API and MCP image tags/digests.
2. Deploy Director API 1.2.0 and verify `/health` reports `auditAutomation: disabled`.
3. Deploy Director MCP 1.2.0 and rediscover tools.
4. Confirm `get_audit_execution_state` is present and the compatibility dispatch/retry tools return `AUTOMATIC_AUDITOR_DISABLED`.
5. Do not invoke Publisher approval, schedule or publish tools during smoke testing.

## Rollback

Restore both previous `audit-automation-1.1.0` image tags/digests in Coolify and perform a rolling redeploy. The new `auditExecutionStates` array is additive JSON data; 1.1.0 ignores it. Historical audit jobs are neither deleted nor rewritten.

Rollback re-enables the former automatic worker, so use it only if that behavior is intentionally desired.
