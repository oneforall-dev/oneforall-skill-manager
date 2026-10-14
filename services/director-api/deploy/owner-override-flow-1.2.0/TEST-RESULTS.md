# Test results — Director 1.2.0 / Publisher 0.8.0

## Director API

- Build: PASS
- Tests: 11/11 PASS
- New READY_FOR_AUDIT state: `AUDITOR_NOT_EXECUTED / AUTOMATIC_AUDITOR_DISABLED`
- Automatic worker imports/calls in runtime entrypoint: none
- Dispatch and retry compatibility endpoints: HTTP 410, no execution
- Existing external PASS result precedence: PASS

## Director MCP

- TypeScript build: PASS
- New read tool: `get_audit_execution_state`
- Historical job inspection remains available through `get_audit_job`

## Publisher

- TypeScript build: PASS
- Unit tests: 13/13 PASS
- Integration tests against local R2/Instagram mocks: 3/3 PASS
- Real Instagram publication calls: none
- Exact OWNER_OVERRIDE remains bound to ITEM_ID, version, content hash, destination account and action; schedule overrides additionally bind timestamp and timezone.
- Auditor PASS and OWNER_OVERRIDE remain independent authorization routes.

## Historical state

No production data, credentials, scheduled posts, published posts or historical audit jobs were modified during these tests.
