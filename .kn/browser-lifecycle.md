# Browser lifecycle

## Three layers, three owners

`browserConfig` is the reusable Chrome launch configuration: target URL,
broker, profile base, SSL behavior, proxy bypass, and headless mode. A durable
`browser` references one config and adds app association, fixed or pooled proxy
selection, an optional profile override, and workflow readme. A live `session`
is the transient broker instance created by starting that browser.

- Provenance: EXTRACTED
- Sources: `packages/server/openapi/browser-configs.json`, `packages/server/openapi/browsers.json`, `packages/server/openapi/sessions.json`

## Stable profile and cleanup

Unless overridden, the server derives a browser profile as
`<config-profile-or-id>__<browser-id>`. Multiple browsers can share one config
without sharing Chrome profile state. Stopping a browser stops its broker
instance but keeps the profile and selected proxy reservation. Destroying the
browser stops any session, clears the derived profile through the broker,
releases the proxy reservation, and removes only the durable browser record.

- Provenance: EXTRACTED
- Sources: `packages/server/src/index.js:1606-1814`, `packages/server/openapi/browsers.json`

## One browser, one live session

A durable browser owns at most one live session. Start returns the session and
its `cdpUrl`; a second start while occupied returns `409`. Parallel work uses
multiple durable browsers that reference the same browser config, rather than
multiple named sessions under one browser.

- Provenance: EXTRACTED/INFERRED
- Sources: `packages/server/src/index.js:1747-1802`, `packages/server/test/server.test.js:580-608`, `e2e/pw-dev.e2e.test.js:141-157`

## Agent lease is separate from Chrome

A session may carry a short-lived lease for the Playwright agent. Claim,
heartbeat, and release change ownership only; they do not start or stop Chrome.
Another owner receives `409` while the lease is live, and may reclaim the
session after expiry. Session stop remains the explicit Chrome cleanup action.

- Provenance: EXTRACTED
- Sources: `packages/server/openapi/sessions.json`, `packages/server/src/index.js:231-249`, `packages/server/test/server.test.js:521-578`

## Proxy pool behavior

When a browser has `proxyIds`, the server selects one available durable proxy
and records the reservation on the browser. A pool is exhausted with `409`;
the server does not share a proxy or create an implicit one. The reservation is
released on browser destruction, not ordinary session stop.

- Provenance: EXTRACTED
- Sources: `packages/server/openapi/browsers.json`, `packages/server/src/index.js:1730-1814`, `packages/server/test/server.test.js:620-688`
