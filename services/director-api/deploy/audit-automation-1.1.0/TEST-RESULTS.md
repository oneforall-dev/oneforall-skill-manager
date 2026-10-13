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
