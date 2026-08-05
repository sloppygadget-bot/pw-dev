# Real user journeys

## 1. Verify an app change in a persistent browser

Discover status/instructions → register or reuse the app → create/reuse its
browser template → start the default session → navigate to `appUrl` and attach
over CDP → perform the verification → stop the session.

The useful failure points are: broker unavailable, missing app/template,
duplicate default session, and leaked session after verification.

- Provenance: INFERRED from `agent.md`, OpenAPI, and existing server tests.
- E2E: `e2e/pw-dev.e2e.test.js` (`app verification lifecycle`)

## 2. Run two independent workers against one app

Reuse one browser template with two named session IDs. Each worker receives a
different profile and CDP URL. Stop one worker and confirm the other remains
live; then stop the other.

- Provenance: EXTRACTED/INFERRED
- Sources: `packages/server/openapi/browsers.json`, existing named-session test
- E2E: `e2e/pw-dev.e2e.test.js` (`parallel named sessions`)

## 3. Allocate isolated traffic for parallel checks

Register durable proxy records → configure a template with `proxyIds` → start
workers until the pool is exhausted → observe `409` for the next worker → stop
one worker → start the waiting worker and verify the released proxy is reused.

- Provenance: EXTRACTED
- Sources: `packages/server/openapi/proxies/index.json`, `browsers.json`, `GRAPH_REPORT.md`
- E2E: `e2e/pw-dev.e2e.test.js` (`exclusive proxy lease lifecycle`)

## 4. Restart without losing app intent

Register app metadata, close and recreate the server against the same worktree,
then confirm durable app metadata is present while live browser state is not.

- Provenance: EXTRACTED
- Sources: `packages/server/src/index.js:635-686`, existing persistence test
- E2E: `e2e/pw-dev.e2e.test.js` (`durable registration across restart`)

