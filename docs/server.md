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
GET /_pwdev/env
GET /_pwdev/instructions
GET /_pwdev/apps
GET /_pwdev/apps/:id/manifest
```

Use `/_pwdev/status` first to verify that the server is healthy and the broker
is configured/reachable. Use `/_pwdev/instructions` as the live usage guide for
the current server. Use `/_pwdev/env` for live server, Playwright, CLI, skill,
and Chromium paths. Use `/_pwdev/client.js` when an agent wants a small helper
module instead of hand-writing manifest fetch and CDP attach logic.
If the broker was started with `--ssh`, `status.broker.status.topology` reports
`{ "mode": "ssh", "remote": true }` plus SSH details. Agents should use that as
the broker topology signal instead of guessing from `localhost` URLs.
When that remote topology is present, a mapped proxy is generally needed for
agent-local debugging traffic. If the browser needs to reach a Whistle proxy
running on the agent machine, prefer `/_pwdev/networks` with
`proxy.mode: "ssh-peer"` so the broker does the port mapping for the remote
browser side.

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

When the broker topology reports `remote: true` with `mode: "ssh"`, prefer a
mapped proxy network for agent-local debugging traffic:

```text
1. Create a managed Whistle proxy with a task-specific ruleset.
2. Read the returned proxyUrl and use its port as proxy.remotePort.
3. Create /_pwdev/networks with proxy.mode: "ssh-peer".
4. Start the browser with networkId.
```

That lets the remote broker browser reach an agent-local proxy for GUI
devserver tapping, API mocking, code injection, and similar debugging work.

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/networks \
  -H 'content-type: application/json' \
  -d '{
    "id": "agent-whistle",
    "kind": "whistle",
    "proxy": { "mode": "ssh-peer", "remotePort": 8899 },
    "browser": { "ignoreSslErrors": true }
  }'
```

Use `proxy.mode: "ssh-peer"` when the proxy is on the SSH peer configured by
broker `--ssh`. Set `proxy.remotePort` to the Whistle port on that SSH peer;
set `proxy.localPort` only if you need a fixed broker-side forwarded port. Use
`"direct"` or `"broker-local"` when the proxy URL is already reachable from the
broker/Chrome host. Start browser sessions with
`networkId`; do not mix `networkId` with `proxyId`, `proxyForwardId`, or
`proxyServer` in the same browser-start request.

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/apps \
  -H 'content-type: application/json' \
  -d '{
    "id": "fortisase-dev",
    "name": "FortisASE dev",
    "worktree": "/home/me/work/fortisase",
    "branch": "main",
    "appUrl": "https://dev.fortisase-sovereign.com",
    "servers": [
      { "name": "react", "port": 5173 },
      { "name": "api", "port": 3100 }
    ],
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
`servers` lists local app processes for monitoring; each entry has a `name` and
local TCP `port`. `devserver` and `engine` are registry metadata for agents and humans.
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

The server calls broker `POST /_broker/start`. With `task.id`, it starts a
task-scoped browser session using session id and profile `<app id>__<task id>`
by default. Sessions are first-class server resources under `/_pwdev/sessions`;
app reads still project task sessions under `browserSessions[sessionId]` for
convenience:

```json
{
  "ok": true,
  "session": {
    "sessionId": "checkout-tax__smoke-login-20260629",
    "taskId": "smoke-login-20260629",
    "profile": "checkout-tax__smoke-login-20260629",
    "browserInstanceId": "bkr_checkout-tax__smoke-login-20260629",
    "cdpUrl": "http://127.0.0.1:9696/_pwdev/broker/instances/bkr_checkout-tax__smoke-login-20260629",
    "activeTask": {
      "id": "smoke-login-20260629",
      "label": "Smoke login flow",
      "owner": "codex",
      "startedAt": "2026-06-29T10:16:05.000Z"
    }
  },
  "app": {
    "id": "checkout-tax",
    "appUrl": "http://127.0.0.1:5174",
    "profile": "checkout-tax",
    "proxyForwardId": "whistle",
    "browserSessions": {
      "checkout-tax__smoke-login-20260629": {
        "sessionId": "checkout-tax__smoke-login-20260629",
        "taskId": "smoke-login-20260629",
        "profile": "checkout-tax__smoke-login-20260629",
        "cdpUrl": "http://127.0.0.1:9696/_pwdev/broker/instances/bkr_checkout-tax__smoke-login-20260629"
      }
    }
  }
}
```

Starting without `task.id` creates the app's default session. App reads project
that default session back onto `cdpUrl`, `browserInstanceId`, and
`activeTask`.

List sessions directly:

```bash
curl http://127.0.0.1:9696/_pwdev/sessions
curl http://127.0.0.1:9696/_pwdev/sessions/checkout-tax__smoke-login-20260629
```

The default task profile can be overridden with an explicit `profile` in the
browser start body. Profile names must contain only letters, numbers, dot,
underscore, and dash.

Duplicate starts are rejected per slot. A second start for the same task id
returns `409 Conflict`:

```json
{
  "ok": false,
  "error": "App already has an active browser session for task",
  "appId": "checkout-tax",
  "sessionId": "checkout-tax__smoke-login-20260629",
  "taskId": "smoke-login-20260629",
  "profile": "checkout-tax__smoke-login-20260629",
  "browserInstanceId": "bkr_checkout-tax__smoke-login-20260629",
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

const started = await fetch('http://127.0.0.1:9696/_pwdev/apps/checkout-tax/browser/start', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    proxyId: 'smoke-login-proxy',
    task: { id: 'smoke-login-20260629', owner: 'codex' },
  }),
}).then((response) => response.json());

const manifest = await fetch('http://127.0.0.1:9696/_pwdev/apps/checkout-tax/manifest')
  .then((response) => response.json());

const cdpUrl = started.session?.cdpUrl ?? manifest.cdpUrl;
const browser = await chromium.connectOverCDP(cdpUrl);
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
curl -X POST http://127.0.0.1:9696/_pwdev/apps/checkout-tax/browser/stop \
  -H 'content-type: application/json' \
  -d '{"taskId":"smoke-login-20260629"}'
```

Stopping with `taskId` removes that task session from `browserSessions`.
Stopping the default slot removes `cdpUrl`, `browserInstanceId`,
`browserStartedAt`, and `activeTask` from the app record. The app registration
remains for later reuse.

Stop by session id directly:

```bash
curl -X POST \
  http://127.0.0.1:9696/_pwdev/sessions/checkout-tax__smoke-login-20260629/stop
```

## Cleanup Policy

Agents should clean up explicitly when a task is complete:

```text
1. Detach Playwright with browser.close().
2. POST /_pwdev/apps/:id/browser/stop with `taskId` for task sessions.
3. DELETE /_pwdev/proxy/proxies/:id for task-scoped managed proxies.
4. Keep the app registration for later tasks.
5. Keep the persistent profile unless a separate reset/clear action is requested.
```

The server does not automatically stop active browser tasks. Automatic cleanup
can interrupt manual login, debugging, or recovery. Session liveness is still
reconciled automatically on app/session reads and browser lifecycle operations:
if broker status no longer reports an instance, the stale server session record
is removed without requiring a manual cleanup call.

## Parallel Verification

An app id has one default browser slot plus task-scoped browser sessions. To
verify multiple fixes on the same branch in parallel, register one app id for
the real app:

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/apps \
  -H 'content-type: application/json' \
  -d '{
    "id": "main",
    "name": "main",
    "appUrl": "http://127.0.0.1:5173",
    "profile": "main"
  }'
```

Then start separate task sessions against that app. Each task gets its own
profile by default:

```text
POST /_pwdev/apps/main/browser/start { "task": { "id": "task-a" } }
POST /_pwdev/apps/main/browser/start { "task": { "id": "task-b" } }
```

Those requests use profiles `main__task-a` and `main__task-b`. Reusing a profile
across concurrent browser instances returns `409 Conflict` or can collide at
the broker/profile-directory layer.

## Endpoints

```text
GET    /_pwdev/status
GET    /_pwdev/instructions
GET    /_pwdev/client.js

GET    /_pwdev/proxies
POST   /_pwdev/proxies
GET    /_pwdev/proxies/:id
DELETE /_pwdev/proxies/:id

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

GET    /_pwdev/apps/:id/browser/status
POST   /_pwdev/apps/:id/browser/start
POST   /_pwdev/apps/:id/browser/stop

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
