# Test results — Social Publisher 0.7.0

Date: 2026-10-13 (America/Bogota)

## Mandatory checks

- TypeScript compilation: PASS (`tsc -p tsconfig.json`).
- Full dependency type-check: PASS (`tsc -p tsconfig.json --noEmit --skipLibCheck false`), including every typed `S3Client.send` call.
- Unit tests: PASS, 9/9.
- Integration tests: PASS, 3/3.
- Real Instagram publication calls: 0.
- Real R2 calls from the test suites: 0. One explicit R2 upload was used only to stage the verified deployment bundle.
- Coolify deployment: PASS; version `0.7.0` is healthy after a rolling update.
- Production content mutations: 0.
- Production credential rotations: 0. Two new Publisher-only Auditor verifier variables were added; no existing credential was changed.
- Scheduled publication mutations: 0.
- Isolated production dependency install: PASS (52 packages, 0 vulnerabilities).
- Isolated Sharp JPEG smoke test: PASS.

## Unit coverage

- Valid authenticated Auditor receipt.
- Tampered signature rejection.
- Unauthorized issuer rejection.
- Expired receipt rejection.
- Legacy migration ordering and additive idempotency schema.
- Stable version/destination-bound publication key.
- Unknown platform outcome classification.
- Secret/token sanitization.
- Watchdog recovery and single threshold trigger.
- Scheduler single-pass processing and blocked-row loop prevention.

## Integration coverage

- Typed `S3Client.send` PUT and HEAD against a local R2-compatible HTTP mock.
- Image container/status/media-publish flow against a local Instagram Graph mock.
- Durable `platform_pending` hook occurs before `media_publish`.
- HTTP 500 during `media_publish` is classified as an unknown outcome and cannot be blindly retried.

The integration suite required local loopback networking and was run outside the filesystem/network sandbox. It contacted only `127.0.0.1` mock servers.

The first sandboxed integration attempt was blocked with `EACCES` on local loopback sockets. The required rerun outside that restriction passed 3/3 and still contacted only local mock services.

Docker is not installed on this workstation, so a local container-image build was not available. The exact npm bundle was instead extracted into a clean directory, installed with production-only dependencies, audited, and exercised with Sharp successfully. Coolify remains the intended image builder during the staged deployment.

## Artifact

- `oneforall-social-publisher-v21-0.7.0.tgz`
- SHA-256: `b60e7857a113660d34a0ad12e97864573a49bc2ed5726df3f0cc25808b4542fe`

## Production read-only verification

- `/health`: PASS; service `oneforall-social-publisher`, version `0.7.0`, database healthy.
- Migration: PASS; runtime log confirms `007_audit_receipts_and_publish_operations.sql` applied.
- MCP discovery: PASS; `register_audit_receipt` is exposed with signature and immutable content binding fields.
- Read-only client listing: PASS.
- Scheduled publications: 19 before and 19 after; the exact persisted post IDs are unchanged.
- Real Instagram publication calls during implementation, tests and smoke checks: 0.
- Real schedule/create/cancel calls during implementation, tests and smoke checks: 0.

## Known operational dependency

Publisher verifies receipts and fails closed, but the installed Oneforall Auditor plugin is instruction-only and does not currently expose a trusted HMAC signing service. Historical records retain their previous behavior; new or materially changed items remain blocked with `AUDIT_REQUIRED` until that independent signer is connected.

The verifier secret was visible in the local automation trace while Coolify confirmed its creation. It was not written to source control or deployment artifacts, but it should be rotated in Coolify before connecting the future Auditor signing service. No rotation was performed after the user's instruction not to modify credentials.

