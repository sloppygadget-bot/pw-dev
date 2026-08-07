# System model

## Control plane

`pw-dev` exposes one server origin under `/_pwdev/*`. It progressively exposes
status, environment, instructions, OpenAPI catalogs, app registration,
reusable browser configs, durable browsers, transient sessions, proxies, and
delegated broker/proxy APIs.

- Provenance: EXTRACTED
- Sources: `packages/server/src/index.js:354-376`, `packages/server/openapi/root.json`, `graphify-out/GRAPH_REPORT.md`

## App attach contract

An app is discovered through its manifest. `appUrl` is where the agent
navigates, while the session `cdpUrl` is the endpoint used for Playwright CDP
attachment. The server owns app/session metadata; the broker owns Chrome
process state.

- Provenance: EXTRACTED
- Sources: `packages/server/src/index.js:72-100`, `packages/server/src/index.js:1166-1183`

## Reusable config, durable browser, transient session

Browser configs hold reusable Chrome launch settings. A durable browser
references one config and composes its app and fixed or pooled proxy choices.
Starting a browser creates one transient broker-backed session named
`<browser-id>__default`; the browser derives a stable profile from the config
and browser id unless a profile override is supplied. Stopping the browser
releases the broker instance but preserves its profile and proxy reservation;
destroying it clears the derived profile, releases the proxy, and removes only
the browser record.

- Provenance: EXTRACTED
- Sources: `packages/server/openapi/browser-configs.json`, `packages/server/openapi/browsers.json`, `packages/server/openapi/sessions.json`, `packages/server/src/index.js:1606-1814`

## Proxy pool lease

`proxyIds` is an ordered reusable pool. Each durable browser selects and
reserves one proxy exclusively; the reservation remains through session stop
and is released when the browser is destroyed. Exhaustion is a meaningful
`409`, not a fallback to sharing or an implicit new proxy. The session lease's
`trafficStartTime` scopes later traffic reads.

- Provenance: EXTRACTED
- Sources: `packages/server/openapi/browsers.json`, `packages/server/src/index.js:1730-1814`, `graphify-out/GRAPH_REPORT.md` (Exclusive Proxy Leases)

## Session ownership lease

The server can attach a short-lived agent lease to a live session. Claim,
heartbeat, and release identify the Playwright owner without changing Chrome
lifecycle; an expired lease makes the live session claimable again. Stopping a
session still stops Chrome, while releasing a lease only releases ownership.

- Provenance: EXTRACTED
- Sources: `packages/server/openapi/sessions.json`, `packages/server/src/index.js:231-249`, `packages/server/src/index.js:1512-1568`

## Operational implication

An agent should discover live instructions first, create or reuse a browser
config and durable browser, use only the server origin, attach to the returned
CDP URL, and stop its session in cleanup. It should heartbeat a claimed lease
while working and release or stop it in cleanup. Direct broker or
proxy-manager ports are implementation details and are not part of the agent
contract.

- Provenance: INFERRED from the documented workflow
- Sources: `packages/server/instructions/agent.md`, `AGENTS.md`, `docs/server.md`
