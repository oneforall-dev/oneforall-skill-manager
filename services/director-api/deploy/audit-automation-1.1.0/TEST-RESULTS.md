# Director audit automation 1.1.0 — test results

Date: 2026-10-13

## Director API

- TypeScript build: PASS
- Unit/integration tests: 9/9 PASS
- Automatic `READY_FOR_AUDIT` HTTP trigger: PASS
- Real Auditor request construction with ordered image inputs and exact copy: PASS using an HTTP integration endpoint
- PASS return and Publisher receipt dispatch: PASS
- CORRECTIONS return and `CORRECTION_REQUIRED`: PASS
- Concurrent deduplication by `ITEM_ID + Director CONTENT_VERSION`: PASS
- Mid-audit content mutation invalidates result: PASS
- Bounded transient retry: PASS
- Missing receipt authentication blocks audit-required Publisher content: PASS
- Social Manager PASS/CORRECTIONS transition: PASS
- Unrelated historical records remain unchanged: PASS

Command:

`npm test`

## Director MCP

- TypeScript build: PASS
- New read/dispatch/retry audit tools compile: PASS

Command:

`npm run build`

## Social Publisher 0.7.0 regression suite

- TypeScript build: PASS
- Unit tests: 9/9 PASS
- Integration tests: 3/3 PASS
- No Instagram publish or schedule call executed.

## Real read-only reconciliation

`WM-NEWS-EDITS-CAROUSELS-20261008`:

- Director version: 2
- Publisher version: 1
- Publisher hash: `b068fd3ac2126b869089d546beffb56c2bb6b5f4d6daa8a4ef8375a1d6a08fc7`
- Ordered labels: `carousel_01.jpg` through `carousel_04.jpg`
- Caption length: 667
- Publisher status: `draft`
- No publish or schedule action executed.

The live Auditor result is intentionally not claimed until the deployed worker completes inspection of the real assets.

## Production deployment verification

Deployment timestamp: 2026-10-14T00:01Z

- GitHub Actions run `38487179441`: PASS for commit `121a49114f85c24f05fbb578556c3232792a71e9`.
- Director API image `audit-automation-1.1.0`: DEPLOYED; `/health` reports version `1.1.0` with the audit worker enabled.
- Director MCP image `audit-automation-1.1.0`: DEPLOYED; `/health` reports version `1.1.0` and the new audit features.
- Previous image tag retained for rollback: `character-vault-auto-scan-2026-10-04`.
- Existing Director `/data` persistent volume retained; no production credentials were changed.

Real smoke test for `WM-NEWS-EDITS-CAROUSELS-20261008`:

- A durable job was created for Director version 2 with ID `ebc4b64884dd69d9a54b76a4d4039fceeb05a1bac22e79e08c0a96ba0deaeedc`.
- The worker reconciled the item boundary and then returned `BLOCKED` before inspection because `OPENAI_API_KEY` is not configured in Director API.
- No verdict was invented and no Auditor `PASS` receipt was created.
- Re-dispatch returned the same job ID, `attempt: 1`, proving deployed idempotency for the unchanged version.
- Director remains `READY_FOR_AUDIT` version 2.
- Publisher remains `draft` version 1 with the same content hash, ordered assets, caption and no approval, schedule or publication.
- Published Wilson records were unchanged (8 before and 8 after).
- One unrelated scheduled record (`ONEFORALL-MISTRAL-LARGE4-20261012`) naturally left the scheduled queue at its pre-existing `2026-10-14T00:00:00Z` execution time during the verification window; the deployment did not edit or trigger it.

Overall status: **BLOCKED, not complete**. All local mandatory tests pass and the reversible deployment is healthy, but a real Auditor verdict cannot be produced until the existing Director API deployment is supplied with an authorized `OPENAI_API_KEY`. This report does not authorize creating, copying, rotating or modifying that credential.
