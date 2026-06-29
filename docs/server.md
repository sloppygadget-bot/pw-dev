# pw-dev Server

`@pw-dev/server` is the agent-facing control plane. It keeps a central app
registry, pairs with one default `@pw-dev/cdp-broker`, starts/stops browser
sessions through that broker, and proxies broker HTTP/WebSocket traffic so
agents can stay on the pw-dev server origin.

## Process Roles

```text
agent/user -> pw-dev server       registry, status, lifecycle, proxied CDP
pw-dev server -> cdp-broker       start/stop/status Chrome sessions
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

Start the server. It probes the default broker URL `http://127.0.0.1:18080`:

```bash
npm start -- server --port 9696
```

Use `--broker-url` only when the broker runs somewhere else. If the default or
configured broker is not reachable, `GET /_pwdev/status` reports
`reachable: false` and browser lifecycle routes return `503`.

## Agent Discovery

Agents should not need hardcoded pw-dev knowledge beyond the base server URL.
Given `PW_DEV_URL=http://127.0.0.1:9696`, the discovery sequence is:

```text
GET /_pwdev/status
GET /_pwdev/instructions
GET /_pwdev/apps
GET /_pwdev/apps/:id/manifest
```

Use `/_pwdev/status` first to verify that the server is healthy and the broker
is configured/reachable. Use `/_pwdev/instructions` as the live usage guide for
the current server. Use `/_pwdev/client.js` when an agent wants a small helper
module instead of hand-writing manifest fetch and CDP attach logic.

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

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/apps \
  -H 'content-type: application/json' \
  -d '{
    "id": "fortisase-dev",
    "name": "FortisASE dev",
    "worktree": "/home/me/work/fortisase",
    "branch": "main",
    "appUrl": "https://dev.fortisase-sovereign.com",
    "devserver": {
      "command": "npm",
      "args": ["run", "dev"],
      "cwd": "/home/me/work/fortisase"
    },
    "engine": {
      "name": "node",
      "version": "v22.16.0",
      "requirement": ">=18"
    },
    "accounts": {
      "login": {
        "usr": "xxx",
        "pwd": "xxx"
      }
    },
    "profile": "fortisase-dev",
    "proxyId": "whistle-main"
  }'
```

`POST /_pwdev/apps` is an upsert. Re-posting the same `id` updates app
metadata, which is useful when branch devservers restart on new ports.
`devserver` and `engine` are metadata-only today; pw-dev records them for
agents and humans but does not execute the command yet.
`accounts` is metadata for non-production test accounts only. Do not register
production accounts, personal credentials, or sensitive tokens.

## Browser Lifecycle

Start the app browser:

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/apps/checkout-tax/browser/start \
  -H 'content-type: application/json' \
  -d '{
    "ignoreSslErrors": true,
    "task": {
      "id": "smoke-login-20260629",
      "label": "Smoke login flow",
      "owner": "codex"
    }
  }'
```

The server calls broker `POST /_broker/start`, then stores a server-proxied
`cdpUrl` on the app:

```json
{
  "id": "checkout-tax",
  "appUrl": "http://127.0.0.1:5174",
  "profile": "checkout-tax",
  "proxyForwardId": "whistle",
  "browserInstanceId": "bkr_checkout-tax",
  "cdpUrl": "http://127.0.0.1:9696/_pwdev/broker/instances/bkr_checkout-tax",
  "activeTask": {
    "id": "smoke-login-20260629",
    "label": "Smoke login flow",
    "owner": "codex",
    "startedAt": "2026-06-29T10:16:05.000Z"
  }
}
```

Attach from Playwright:

```js
import { chromium } from 'playwright';

const manifest = await fetch('http://127.0.0.1:9696/_pwdev/apps/checkout-tax/manifest')
  .then((response) => response.json());

const browser = await chromium.connectOverCDP(manifest.cdpUrl);
const context = browser.contexts()[0];
const page = context.pages()[0] ?? await context.newPage();

await page.goto(manifest.appUrl);
```

Check browser/broker status:

```bash
curl http://127.0.0.1:9696/_pwdev/apps/checkout-tax/browser/status
```

Stop the app browser:

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/apps/checkout-tax/browser/stop
```

Stopping removes `cdpUrl`, `browserInstanceId`, and `browserStartedAt` from the
app record. It also clears `activeTask`. The app registration remains for later
reuse.

`browser/start` is strict by default. If the app already has `browserInstanceId`
or `activeTask`, the server returns `409 Conflict` and does not call the broker:

```json
{
  "ok": false,
  "error": "App already has an active browser task",
  "appId": "checkout-tax",
  "browserInstanceId": "bkr_checkout-tax",
  "activeTask": {
    "id": "smoke-login-20260629",
    "label": "Smoke login flow",
    "owner": "codex",
    "startedAt": "2026-06-29T10:16:05.000Z"
  }
}
```

## Cleanup Policy

Agents should clean up explicitly when a task is complete:

```text
1. Detach Playwright with browser.close().
2. POST /_pwdev/apps/:id/browser/stop.
3. Keep the app registration for later tasks.
4. Keep the persistent profile unless a separate reset/clear action is requested.
```

The server does not automatically stop active browser tasks. Automatic cleanup
can interrupt manual login, debugging, or recovery. A future lease/TTL mechanism
can warn about stale tasks without making browser termination implicit.

## Parallel Verification

An app id has one active browser task by default. This keeps ownership simple:
one app id maps to one profile, one broker instance, and one active task. If a
second task tries to start on the same app id, the server returns `409 Conflict`.

To verify multiple fixes on the same branch in parallel, register multiple app
ids that point at the same `appUrl` but use distinct profiles:

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/apps \
  -H 'content-type: application/json' \
  -d '{
    "id": "main-fix-a",
    "name": "main fix A",
    "appUrl": "http://127.0.0.1:5173",
    "profile": "main-fix-a"
  }'

curl -X POST http://127.0.0.1:9696/_pwdev/apps \
  -H 'content-type: application/json' \
  -d '{
    "id": "main-fix-b",
    "name": "main fix B",
    "appUrl": "http://127.0.0.1:5173",
    "profile": "main-fix-b"
  }'
```

Each slot can then start its own browser task:

```text
POST /_pwdev/apps/main-fix-a/browser/start
POST /_pwdev/apps/main-fix-b/browser/start
```

Use separate profiles for parallel slots. Reusing a profile across concurrent
browser instances can collide at the broker/profile-directory layer.

## Endpoints

```text
GET    /_pwdev/status
GET    /_pwdev/instructions
GET    /_pwdev/client.js

GET    /_pwdev/proxies
POST   /_pwdev/proxies
GET    /_pwdev/proxies/:id
DELETE /_pwdev/proxies/:id

GET    /_pwdev/apps
POST   /_pwdev/apps
GET    /_pwdev/apps/:id
DELETE /_pwdev/apps/:id
GET    /_pwdev/apps/:id/manifest

GET    /_pwdev/apps/:id/browser/status
POST   /_pwdev/apps/:id/browser/start
POST   /_pwdev/apps/:id/browser/stop

ANY    /_pwdev/broker/*
WS     /_pwdev/broker/*
```

`/_pwdev/broker/*` maps to broker `/_broker/*`. It is mainly used for proxied
CDP URLs, but it also leaves a raw broker API escape hatch for advanced tooling.

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
    "running": true
  }
}
```

## Key Files And Functions

[packages/server/src/index.js](/home/pengxie/work/pw-dev/packages/server/src/index.js)

- `startPwDevServer`: starts the HTTP server, seeds the default app, pairs the broker, and installs the broker WebSocket proxy.
- `handlePwDevRequest`: dispatches all `/_pwdev/*` HTTP routes.
- `createAppRegistry`: process-local app registry with list/get/upsert/update/delete.
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
