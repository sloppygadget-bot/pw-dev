# System model

## Control plane

`pw-dev` exposes one server origin under `/_pwdev/*`. It progressively exposes
status, environment, instructions, OpenAPI catalogs, app registration,
browser templates, sessions, proxies, and delegated broker/proxy APIs.

- Provenance: EXTRACTED
- Sources: `packages/server/src/index.js:354-376`, `packages/server/openapi/root.json`, `graphify-out/GRAPH_REPORT.md`

## App attach contract

An app is discovered through its manifest. `appUrl` is where the agent
navigates, while the session `cdpUrl` is the endpoint used for Playwright CDP
attachment. The server owns app/session metadata; the broker owns Chrome
process state.

- Provenance: EXTRACTED
- Sources: `packages/server/src/index.js:72-100`, `packages/server/src/index.js:1166-1183`

## Persistent template, transient session

Browser templates are durable configuration. A start creates a transient
session named `<template-id>__<session-id>` (or the default slot), and stop
releases the broker instance and any exclusive proxy lease.

- Provenance: EXTRACTED
- Sources: `packages/server/openapi/browsers.json`, `packages/server/openapi/sessions.json`, `packages/server/src/index.js:1373-1486`

## Proxy pool lease

`proxyIds` is an ordered reusable pool. Each live session owns one proxy
exclusively until it stops. Exhaustion is a meaningful `409`, not a fallback to
sharing or an implicit new proxy. The lease's `trafficStartTime` scopes later
traffic reads.

- Provenance: EXTRACTED
- Sources: `packages/server/openapi/browsers.json`, `packages/server/src/index.js:198-199`, `graphify-out/GRAPH_REPORT.md` (Exclusive Proxy Leases)

## Operational implication

An agent should discover live instructions first, use only the server origin,
attach to the returned CDP URL, and stop its session in cleanup. Direct broker
or proxy-manager ports are implementation details and are not part of the
agent contract.

- Provenance: INFERRED from the documented workflow
- Sources: `packages/server/instructions/agent.md`, `AGENTS.md`, `docs/server.md`

