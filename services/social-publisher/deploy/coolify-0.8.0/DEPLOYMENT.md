# Reversible deployment — Social Publisher 0.8.0

## Scope

- Backend only. Do not update ChatGPT plugin instructions or skills.
- Add migration `008_owner_overrides.sql`.
- Preserve every existing publication, schedule, OAuth token, R2 asset and audit receipt.
- Do not invoke Instagram publish or scheduling tools during smoke tests.

## Rollback

- Current rollback application version: 0.7.0.
- Migration 008 is additive. Version 0.7.0 ignores `audit_required_at` and `owner_overrides`, so application rollback does not require destructive database rollback.
- Preserve the 0.8.0 evidence tables during rollback.

## Smoke test

1. Verify `/live` and `/ready` report 0.8.0 and healthy PostgreSQL.
2. Verify MCP discovery includes `register_owner_override`.
3. Read an existing item and confirm its persisted state is unchanged.
4. Do not create an override for production content during deployment verification.
5. Compare scheduled and published records before/after.
6. Confirm runtime logs applied migration 008.
