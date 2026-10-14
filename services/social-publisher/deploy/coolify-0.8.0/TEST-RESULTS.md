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

Not yet deployed. Production must remain on 0.7.0 until the reversible 0.8.0 bundle is staged and its migration is verified without invoking any publish or schedule action.

Artifact: `oneforall-social-publisher-v21-0.8.0.tgz`  
SHA-256: `6dab31b0551ce97e351b966247eb6b727b842096e7b70adee9bc8045115ec046`
