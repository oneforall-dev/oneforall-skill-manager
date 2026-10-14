# Test results — Social Publisher 0.8.0

Date: 2026-10-14 (America/Bogota)

## Mandatory checks

- TypeScript build: PASS.
- Full dependency type-check (`--skipLibCheck false`): PASS.
- Unit tests: 13/13 PASS.
- Integration tests: 3/3 PASS against local-only R2 and Instagram mocks.
- Real Instagram publish/schedule calls: 0.
- Production credentials changed: 0.
- Existing scheduled/published records changed by tests: 0.

## Authorization behavior

- Exact authenticated Auditor PASS remains a valid route.
- Exact `OWNER_OVERRIDE` is a separate route and never writes an Auditor receipt.
- Override binds owner, ITEM_ID, version, content hash/snapshot, destination account and action.
- Schedule override also binds the exact timestamp and timezone.
- Version, hash, account, action, schedule or timezone mismatch: rejected.
- Missing Auditor evidence becomes `AUDITOR_NOT_EXECUTED` after the bounded timeout.
- Without PASS, OWNER_OVERRIDE or legacy grandfathering: blocked.
- Existing legacy rows remain grandfathered; historical state is not rewritten.
- Existing duplicate-publication and ambiguous-outcome protections remain active.

## Deployment status

Deployed successfully to the existing SocialPublisher Coolify application on 2026-10-14.

- Source commit: `42770f2d5f5e28f45565d31cac281a71bb9bef0a`.
- GitHub Actions run: `38503819147` — SUCCESS.
- Deployment source is pinned to the immutable commit archive; it no longer depends on a client R2 asset.
- `/live`: 0.8.0.
- `/ready`: 0.8.0, PostgreSQL ready.
- MCP discovery exposes `register_owner_override`.
- Reading an existing Content Item succeeded through the migration-008 query path.
- Scheduled records before/after: 17/17, exact identity/version/timestamp snapshot unchanged.
- Published records before/after: 75/75, exact identity/version/media-id/timestamp snapshot unchanged.
- Real Instagram publish/schedule calls during deployment verification: 0.
- Credentials or environment secrets changed: 0.
- Rollback remains application version 0.7.0; migration 008 is additive and deliberately retained.

Artifact: `oneforall-social-publisher-v21-0.8.0.tgz`  
SHA-256: `6dab31b0551ce97e351b966247eb6b727b842096e7b70adee9bc8045115ec046`
