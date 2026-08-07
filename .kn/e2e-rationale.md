# E2E test design

The suite is black-box at the product boundary: it uses Playwright's request
client against a live `startPwDevServer` instance and never imports route
handlers or reaches internal ports directly. A deterministic broker double
models Chrome lifecycle and CDP discovery; a proxy-manager double models
managed proxy startup. This keeps the journeys realistic while making tests
repeatable on a machine without Chrome, Whistle, or a running daemon.

The suite asserts user-visible contracts: discovery, app/browser-config/browser/
session state, returned CDP URLs, stable profile isolation, proxy reservation
exclusivity/reuse, agent lease ownership, and persistence semantics.
It does not pretend that a fake CDP endpoint proves Playwright can drive a real
page; that concern belongs to a separately configured smoke run with the real
broker and Chromium.

- Provenance: INFERRED design decision
- Sources: `AGENTS.md`, `packages/server/instructions/agent.md`, `packages/server/openapi/browser-configs.json`, `packages/server/openapi/browsers.json`, `packages/server/openapi/sessions.json`, `packages/server/test/server.test.js`
