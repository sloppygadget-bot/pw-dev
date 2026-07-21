# pw-dev Server

`@pw-dev/server` is the agent-facing control plane. It keeps a central app
registry, pairs with one default `@pw-dev/cdp-broker`, starts/stops browser
sessions through that broker, and proxies broker HTTP/WebSocket traffic so
agents can stay on the pw-dev server origin. It can also proxy the optional
`@pw-dev/proxy` API for managed Whistle process creation.

## Process Roles

```text
agent/user -> pw-dev server       registry, status, lifecycle, proxied CDP
pw-dev server -> cdp-broker       start/stop/status Chrome sessions
pw-dev server -> proxy            proxied Whistle process lifecycle
cdp-broker -> Chrome              persistent profile + CDP endpoint
Chrome -> app devserver           loads the registered appUrl
```

The broker URL is server configuration. Normal app records should not carry
`brokerUrl`.

## Start

Start the broker:

```bash
npm start -- broker --standby
```

For an SSH-backed broker, use the dependency-light direct broker entrypoint:

```bash
node packages/cdp-broker/bin/pw-cdp-broker.js --standby --ssh user@target-server
```

Start the server. It probes the default broker URL `http://127.0.0.1:18080`:

```bash
npm start -- server --port 9696
```

Use `--broker-url` only when the broker runs somewhere else. If the default or
configured broker is not reachable, `GET /_pwdev/status` reports
`reachable: false` and browser lifecycle routes return `503`.

The app registry persists in `<worktree>/.pw-dev/apps.json` by default. Pass
`--app-registry-file <file>` to place it elsewhere. Browser sessions are
broker-owned runtime state and are intentionally not restored after a server
restart.

Network definitions persist in `<worktree>/.pw-dev/networks.json`; when a
broker is reachable, the server restores those definitions before a network is
used for a browser start.

Browser templates persist in `<worktree>/.pw-dev/browsers.json`. A template
contains `id`, optional `appId` and `targetUrl`, optional `profile`,
`networkId`, `proxyId`, broker override, and browser launch options. `appId`
links an app's instructions/accounts/defaults when applicable; omit it for a
standalone crawler or generic automation browser. Its live broker instance is transient:
after a broker restart, start the same template again rather than recreating
its configuration.

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/browsers \
  -H 'content-type: application/json' \
  -d '{"id":"checkout-tax","appId":"checkout-tax","networkId":"agent-whistle","ignoreSslErrors":true}'
curl -X POST http://127.0.0.1:9696/_pwdev/browsers/checkout-tax/start
curl -X POST http://127.0.0.1:9696/_pwdev/browsers/checkout-tax/stop
```

Managed proxy configuration and rules are stored in each proxy's Whistle
profile directory. The proxy manager reloads those profiles as stopped proxies
after restart; use the server-proxied lifecycle endpoints to start them again:
`POST /_pwdev/proxy/proxies/:id/start`, `.../:id/stop`, and `.../:id/restart`.

`pw-dev server` starts the proxy manager lazily on the first proxy operation
and stops it on shutdown. The local manager listens on
`http://127.0.0.1:9697` and is proxied under `/_pwdev/proxy/*`. It creates
Whistle instances from external-agent
rulesets, allocates separate proxy and GUI ports, registers the resulting
proxy metadata, and can attach that proxy to an app by patching the app
`proxyId`. Each managed Whistle proxy is started with isolated `-S` storage
under `packages/proxy/.runtime/whistle` and HTTPS capture enabled
(`Enable HTTPS / Capture Tunnel Traffic`); the proxy manager removes that
directory when the proxy exits or is stopped.

Use `--no-proxy-manager` when managing the proxy service separately, or pass an
external manager with `--proxy-manager-url`. The standalone `npm start -- proxy`
command remains available for that setup.

Most managed proxies should be scoped to one task/test/verification. Agents can
tag them with `taskId`, `owner`, `purpose`, and `labels`, then start a browser
session with the returned `proxy.id` and delete the proxy when the task ends.
If the proxy manager is restarted after a crash, it automatically terminates
orphaned pw-dev Whistle processes before accepting new proxies. This cleanup is
limited to processes launched with a `-S` storage directory under the configured
Whistle storage root, so unrelated Whistle instances are not stopped.
Compose the `ruleset` for the debugging job at hand: point app traffic at a
GUI devserver, mock API responses, inject local code, or combine those
behaviors in one task-scoped proxy:

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/proxy/proxies \
  -H 'content-type: application/json' \
  -d '{
    "id": "smoke-login-proxy",
    "taskId": "smoke-login-20260703",
    "owner": "codex",
    "purpose": "Smoke login API rewrite",
    "labels": ["smoke", "verification"],
    "ruleset": "example.com 127.0.0.1:3000"
  }'
```

Shared managed proxies do not need an `appId`. To use one, pass its id as
`proxyId` in each browser start request or store that `proxyId` on each app
registration that should use it. Supplying `appId` during managed proxy
creation is only a convenience: the proxy manager patches that app's `proxyId`
for you.

Managed proxies expose live rules state at `proxy.rules`. Replace the complete
rules state with `PUT /_pwdev/proxy/proxies/:id/rules`, sending both the default
and override rulesets with `baseVersion`. Read the current `proxy.rules`, compute
the desired replacement, and write it in place. The proxy and browser continue
running, and `baseVersion` prevents lost updates:

```bash
CURRENT=$(curl -s http://127.0.0.1:9696/_pwdev/proxy/proxies/smoke-login-proxy)

curl -X PUT http://127.0.0.1:9696/_pwdev/proxy/proxies/smoke-login-proxy/rules \
  -H 'content-type: application/json' \
  -d "{
    \"baseVersion\": $(printf '%s' \"$CURRENT\" | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>process.stdout.write(String(JSON.parse(s).proxy.rules.version)))'),
    \"defaultRuleset\": $(printf '%s' \"$CURRENT\" | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>process.stdout.write(JSON.stringify(JSON.parse(s).proxy.rules.defaultRuleset)))'),
    \"overrideRuleset\": \"example.com/api/orders/preview resBody://{ \\\"ok\\\": true, \\\"source\\\": \\\"mock\\\" }\"
  }"
```

## Agent Discovery

Agents should not need hardcoded pw-dev knowledge beyond the base server URL.
Given `PW_DEV_URL=http://127.0.0.1:9696`, the discovery sequence is:

```text
GET /_pwdev/status
GET /_pwdev/openapi.json
GET /_pwdev/instructions
GET /_pwdev/apps
GET /_pwdev/apps/:id/manifest
```

Use `/_pwdev/status` first to verify that the server is healthy and the broker
is configured/reachable. Then use `/_pwdev/openapi.json` as the compact catalog
and follow only its relevant `x-pwdev-documents` link. Use
`/_pwdev/instructions` as the live operational guide. Use `/_pwdev/env` for live server, Playwright, CLI, skill,
and Chromium paths. Use `/_pwdev/client.js` when an agent wants a small helper
module instead of hand-writing manifest fetch and CDP attach logic.
If the broker was started with `--ssh`, `status.broker.status.topology` reports
`{ "mode": "ssh", "remote": true }` plus SSH details. Agents should use that as
the broker topology signal instead of guessing from `localhost` URLs.
When that remote topology is present, start the browser with a registered
`proxyId`. The broker automatically creates or reuses the required mapping to
the proxy on its SSH peer; agents do not need proxy-forward IDs or ports.

`/_pwdev/manifest` describes the server root, but it is not automatically added
to `/_pwdev/apps`. Register apps explicitly with `POST /_pwdev/apps`; use
`--register-default-app` only when the root manifest should also appear as an
app.

Generated Playwright task code should live inside the pw-dev workspace so it
uses the Playwright package shipped with pw-dev. The Playwright package, CLI,
Chromium browser, and bundled probing skills are installed by `npm install`.
To repeat that setup explicitly, run `npm run install:playwright`. Use:

That install step also makes the Playwright CLI and its bundled probing skills
available inside pw-dev. Use the package, CLI, and bundled skills for browser
probing and smoke-check tasks before writing a custom script.

```text
.agent/tasks/<task-id>/run.mjs
.agent/tasks/<task-id>/artifacts/
```

This is the default location for generated Playwright scripts and artifacts.
You can copy the script elsewhere if you want to run it against another
Playwright install or keep it outside pw-dev.

Generated scripts should import `chromium` from `playwright` and connect to the
`cdpUrl` returned by pw-dev. They should not launch a separate browser.

Minimal agent bootstrap:

```js
const baseUrl = process.env.PW_DEV_URL;

const status = await fetch(`${baseUrl}/_pwdev/status`)
  .then((response) => response.json());

if (!status.broker?.configured) {
  throw new Error('pw-dev broker status is unavailable');
}

if (status.broker.reachable === false) {
  throw new Error(`pw-dev broker is unreachable: ${status.broker.error}`);
}

const apps = await fetch(`${baseUrl}/_pwdev/apps`)
  .then((response) => response.json());
```

For a selected app, the manifest is the attach contract:

```js
const manifest = await fetch(`${baseUrl}/_pwdev/apps/checkout-tax/manifest`)
  .then((response) => response.json());
```

## Register An App

Register shared proxy metadata first when multiple apps should use the same
Whistle or HTTP proxy:

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/proxies \
  -H 'content-type: application/json' \
  -d '{
    "id": "whistle-main",
    "kind": "whistle",
    "name": "Shared Whistle",
    "proxyUrl": "http://127.0.0.1:8899"
  }'
```

Proxy registrations are reusable metadata. They have no runner or status.
Update a proxy port by re-posting the same `id` with a different `proxyUrl`.
Use `brokerProxyForwardId` instead of `proxyUrl` when the broker owns the
forward, but do not set both fields.

For new browser-start workflows, prefer broker networks. A network is a named
browser routing profile owned by the broker. The server proxies these APIs to
the broker under `/_pwdev/networks`.

When the broker topology reports `remote: true` with `mode: "ssh"`, select the
managed proxy by `proxyId` when starting the browser. The broker maps the proxy
on its SSH peer automatically and reuses that mapping for later starts.

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/browsers \
  -H 'content-type: application/json' \
  -d '{"id":"checkout-tax","appId":"checkout-tax","proxyId":"whistle-main","ignoreSslErrors":true}'
curl -X POST http://127.0.0.1:9696/_pwdev/browsers/checkout-tax/start
```

Use `networkId` only for a named routing policy that is distinct from a managed
proxy. Do not create or pass `proxyForwardId` for normal browser starts; it is
broker-internal diagnostic state.

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/apps \
  -H 'content-type: application/json' \
  -d '{
    "id": "fortisase-dev",
    "name": "FortisASE dev",
    "worktree": "/home/me/work/fortisase",
    "branch": "main",
    "readme": "Run npm run dev before testing. Copy .env.example to .env.local.",
    "accounts": {
      "login": {
        "usr": "xxx",
        "pwd": "xxx"
      }
    },
    "proxyId": "whistle-main"
  }'
```

`POST /_pwdev/apps` is an upsert. Re-posting the same `id` updates app
metadata. Use `readme` for concise, app-specific agent instructions: how to
operate devserver(s), required environment or local setup, test-data limits,
and task precautions. For a proxy-enabled app, also include the proxy-rule
template path, how to compose or compile the ruleset, its required inputs, and
how to apply the finished rules through the server-proxied proxy API.
`accounts` is metadata for non-production test accounts only. Do not register
production accounts, personal credentials, or sensitive tokens.

## Browser templates and sessions

Create a persisted browser template, then start it without a launch payload:

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/browsers \
  -H 'content-type: application/json' \
  -d '{"id":"checkout-tax","appId":"checkout-tax","targetUrl":"http://127.0.0.1:5174","profile":"checkout-tax","ignoreSslErrors":true}'
curl -X POST http://127.0.0.1:9696/_pwdev/browsers/checkout-tax/start
```

The response contains a transient session with its `cdpUrl`. Attach Playwright
to that URL and navigate to `browser.targetUrl` when present. Sessions are the
server's reconciled view of live broker instances; broker status remains the
source of truth. Stop the template or its session explicitly:

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/browsers/checkout-tax/stop
curl -X POST http://127.0.0.1:9696/_pwdev/sessions/checkout-tax__default/stop
```

For parallel isolated instances from one template, pass a `sessionId`. pw-dev
derives a separate persistent profile (`<template-id>__<session-id>`) unless a
different `profile` is supplied:

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/browsers/checkout-tax/start \
  -H 'content-type: application/json' \
  -d '{"sessionId":"shard-1"}'
curl -X POST http://127.0.0.1:9696/_pwdev/browsers/checkout-tax/stop \
  -H 'content-type: application/json' \
  -d '{"sessionId":"shard-1"}'
```

Apps no longer own browser lifecycle. The retired
`/_pwdev/apps/:id/browser/*` routes return `410 Gone`.

## Endpoints

```text
GET    /_pwdev/status
GET    /_pwdev/instructions
GET    /_pwdev/client.js

GET    /_pwdev/proxies
POST   /_pwdev/proxies
GET    /_pwdev/proxies/:id
DELETE /_pwdev/proxies/:id
GET    /_pwdev/proxies/:id/traffic

GET    /_pwdev/networks
POST   /_pwdev/networks
GET    /_pwdev/networks/:id
DELETE /_pwdev/networks/:id
POST   /_pwdev/networks/:id/check

GET    /_pwdev/sessions
GET    /_pwdev/sessions/:id
POST   /_pwdev/sessions/:id/stop

GET    /_pwdev/apps
POST   /_pwdev/apps
GET    /_pwdev/apps/:id
DELETE /_pwdev/apps/:id
GET    /_pwdev/apps/:id/manifest

GET    /_pwdev/browsers
POST   /_pwdev/browsers
GET    /_pwdev/browsers/:id
DELETE /_pwdev/browsers/:id
POST   /_pwdev/browsers/:id/start
POST   /_pwdev/browsers/:id/stop

ANY    /_pwdev/broker/*
WS     /_pwdev/broker/*

GET    /_pwdev/proxy/status
GET    /_pwdev/proxy/proxies
POST   /_pwdev/proxy/proxies
GET    /_pwdev/proxy/proxies/:id
PUT    /_pwdev/proxy/proxies/:id/rules
DELETE /_pwdev/proxy/proxies/:id
POST   /_pwdev/proxy/proxies/:id/stop
POST   /_pwdev/proxy/stop-all
```

`/_pwdev/broker/*` maps to broker `/_broker/*`. It is mainly used for proxied
CDP URLs, but it also leaves a raw broker API escape hatch for advanced tooling.
`/_pwdev/proxy/*` maps to `proxy` `/_proxy/*`, so agents can create/delete
managed Whistle instances without knowing the manager port.

For an `ssh-peer` network, `POST /_pwdev/networks/:id/check` actively probes
the broker-resolved local proxy forward with an HTTP `CONNECT` handshake. A
response from the remote proxy confirms that the SSH tunnel reaches its peer.
The optional JSON body accepts `host`, `port`, and `timeoutMs`:

```bash
curl -s -X POST http://127.0.0.1:9696/_pwdev/networks/agent-whistle/check \
  -H 'content-type: application/json' \
  -d '{"host":"example.com","port":80,"timeoutMs":3000}' | jq
```

The response includes `reachable`, `probe.statusCode`, `probe.latencyMs`, and
an error string when the SSH forward or remote proxy cannot be reached.

## Broker Diagnostics

Default broker configured but unreachable:

```json
{
  "configured": true,
  "reachable": false,
  "url": "http://127.0.0.1:18080",
  "default": true,
  "error": "Broker is unreachable at http://127.0.0.1:18080: fetch failed"
}
```

Explicit broker configured but unreachable:

```json
{
  "configured": true,
  "reachable": false,
  "url": "http://127.0.0.1:18080",
  "error": "fetch failed"
}
```

Reachable broker:

```json
{
  "configured": true,
  "reachable": true,
  "url": "http://127.0.0.1:18080",
  "status": {
    "ok": true,
    "state": "active",
    "instanceCount": 1
  }
}
```

## Key Files And Functions

[packages/server/src/index.js](/home/pengxie/work/pw-dev/packages/server/src/index.js)

- `startPwDevServer`: starts the HTTP server, builds the root manifest, pairs the broker, and installs the broker WebSocket proxy.
- `handlePwDevRequest`: dispatches all `/_pwdev/*` HTTP routes.
- `createAppRegistry`: app registry with list/get/upsert/update/delete; the server persists it by default.
- `createProxyRegistry`: process-local reusable proxy registry with list/get/upsert/delete.
- `buildManifest`: builds the default root manifest.
- `serveStatic` and `resolveStaticPath`: static file serving and root-safe path resolution.
- `proxyBrokerHttpRequest` and `proxyBrokerUpgrade`: broker HTTP/WebSocket proxy for `/_pwdev/broker/*`.
- `handleAppBrowserRequest`: app-scoped browser start/status/stop lifecycle.

[packages/server/src/cli.js](/home/pengxie/work/pw-dev/packages/server/src/cli.js)

- `main`: CLI entry point for `pw-dev server`.
- `parseArgs`: maps CLI flags to `startPwDevServer` options.
- `helpText`: user-facing server CLI help.

[packages/server/test/server.test.js](/home/pengxie/work/pw-dev/packages/server/test/server.test.js)

- Covers static serving, manifest/status endpoints, registry operations,
  app browser lifecycle, broker reachability diagnostics, HTTP proxying, and
  WebSocket upgrade proxying.
