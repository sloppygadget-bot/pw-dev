# Real user journeys

## 1. Verify an app change in a persistent browser

Discover status/instructions → register or reuse the app → create/reuse a
browser config → create/reuse a durable browser linked to the app → start its
session → navigate to `appUrl` and attach over CDP → perform the verification
→ stop the session and release its agent lease.

The useful failure points are: broker unavailable, missing app/config/browser,
occupied browser, proxy-pool exhaustion, and an expired or leaked session
lease after verification.

- Provenance: INFERRED from `agent.md`, OpenAPI, and existing server tests.
- E2E: `e2e/pw-dev.e2e.test.js` (`documented browser lifecycle`)

## 2. Run two independent workers against one app

Create two durable browsers that share one browser config and app. Each browser
receives a different stable derived profile and CDP URL. Stop one worker and
confirm the other remains live; then destroy both browsers when their retained
profiles and proxy reservations are no longer needed.

- Provenance: EXTRACTED/INFERRED
- Sources: `packages/server/openapi/browser-configs.json`, `packages/server/openapi/browsers.json`, `packages/server/test/server.test.js:580-608`
- E2E: `e2e/pw-dev.e2e.test.js` (`parallel browsers sharing one config stay isolated and clean up independently`)

## 3. Allocate isolated traffic for parallel checks

Register durable proxy records → create one browser config → create browsers
with the same `proxyIds` pool → start browsers until the pool is exhausted →
observe `409` for the next browser → destroy one browser → start the waiting
browser and verify the released proxy is reused.

- Provenance: EXTRACTED
- Sources: `packages/server/openapi/proxies/records.json`, `packages/server/openapi/browsers.json`, `packages/server/src/index.js:1730-1814`, `GRAPH_REPORT.md`
- E2E: `e2e/pw-dev.e2e.test.js` (`parallel browsers share proxy pool with exclusive reservations`)

## 4. Restart without losing app intent

Register app metadata, close and recreate the server against the same worktree,
then confirm durable app, browser-config, browser, and proxy metadata are
present while the transient broker-backed session and agent lease are not.

- Provenance: EXTRACTED
- Sources: `packages/server/src/index.js:336-354`, `packages/server/test/server.test.js:805-835`
- E2E: `packages/server/test/server.test.js` (`server persists browser configuration but not its transient session`)

## 5. Recover ownership after an abandoned agent

Start a browser with or without a lease → claim the live session → heartbeat
while working → verify a second owner receives `409` → let the lease expire →
reclaim it with the new owner. The session and Chrome process remain live
through lease expiry; only ownership changes.

- Provenance: EXTRACTED
- Sources: `packages/server/openapi/sessions.json`, `packages/server/test/server.test.js:521-578`
