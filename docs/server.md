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

## Remote Linux Brokers

The server can provision a broker on a Linux SSH peer and keep a local forward
healthy:

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/remote-brokers \
  -H 'content-type: application/json' \
  -d '{"id":"lab","target":"agent@10.11.2.2"}'
```

The server compares the remote checkout with its own Git revision first. A
missing checkout is cloned into `~/.pw-dev/pw-dev`; an existing clean checkout
is updated when needed. A healthy remote broker at the matching revision is
reused. An update stops and restarts only the pw-dev-managed broker, and a
dirty checkout or unmanaged running broker fails safely instead of being
overwritten.

Remote setup requires Node 18+. When the default `node` is older, pw-dev
loads `~/.nvm/nvm.sh`; if NVM is absent, it installs pinned NVM
`v0.40.6` with the official installer (without editing shell profiles), then
installs and selects Node 18 for the broker process.

The response contains `remoteBroker.brokerUrl`, such as
`http://127.0.0.1:18083`. This is a loopback-only SSH forward; it selects an
available local port from `18080` through `18089` unless `localPort` is
supplied. Use it as a browser config's advanced `brokerUrl` override.

The server sends SSH keepalives and actively probes `/_broker/status`. A
powered-off host, network failure, or zombie/half-open forward moves the
record to `reconnecting` and retries with backoff until it recovers or is
explicitly released:

```bash
curl http://127.0.0.1:9696/_pwdev/remote-brokers
curl -X POST http://127.0.0.1:9696/_pwdev/remote-brokers/lab/disconnect
curl -X POST http://127.0.0.1:9696/_pwdev/remote-brokers/lab/stop
```

`disconnect` (or `DELETE /_pwdev/remote-brokers/:id`) releases only the local
forward. `stop` releases it and sends `SIGTERM` only when the remote pid file
verifies that the process is the pw-dev-managed broker. The server does not
store SSH credentials; OpenSSH handles host-key, password, passphrase, and MFA
prompts.

The app registry persists in `<worktree>/.pw-dev/apps.json` by default. Pass
`--app-registry-file <file>` to place it elsewhere. Browser sessions are
broker-owned runtime state and are intentionally not restored after a server
restart.

Browser configs persist in `<worktree>/.pw-dev/browser-configs.json`. A config
contains reusable Chrome launch settings such as `targetUrl`, `profile`, broker
override, SSL handling, and headless mode. It cannot be started directly.
Browsers persist in `<worktree>/.pw-dev/browsers.json`; each browser requires a
`browserConfigId` and may reference an app and one fixed proxy or proxy pool.

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/browser-configs \
  -H 'content-type: application/json' \
  -d '{"id":"checkout-chrome","ignoreSslErrors":true}'
curl -X POST http://127.0.0.1:9696/_pwdev/browsers \
  -H 'content-type: application/json' \
  -d '{"id":"checkout-tax","browserConfigId":"checkout-chrome","appId":"checkout-tax","proxyId":"whistle-main"}'
curl -X POST http://127.0.0.1:9696/_pwdev/browsers/checkout-tax/start
curl -X POST http://127.0.0.1:9696/_pwdev/browsers/checkout-tax/stop
```

Managed proxy configuration and rules are stored in each proxy's Whistle
profile directory. Browser start and stop normally own the Whistle process
lifecycle; the explicit server-proxied lifecycle endpoints remain available:
`POST /_pwdev/proxy/proxies/:id/start`, `.../:id/stop`, and `.../:id/restart`.

`pw-dev server` starts the proxy manager lazily on the first proxy operation
and stops it on shutdown. The local manager listens on
`http://127.0.0.1:9697` and is proxied under `/_pwdev/proxy/*`. It creates
Whistle instances from external-agent
rulesets, allocates separate proxy and GUI ports, registers the resulting
proxy metadata, and can attach that proxy to an app by patching the app
`proxyId`. Each managed Whistle proxy uses isolated `-S` storage
under `packages/proxy/.runtime/whistle` and HTTPS capture enabled
(`Enable HTTPS / Capture Tunnel Traffic`); the proxy manager removes that
directory only when the proxy is explicitly deleted. Creating a profile does
not start Whistle. Browser start launches it on demand, and stopping the last
session using it stops Whistle. Process exit, stop, manager shutdown, and
browser lease release preserve the profile.

Use `--no-proxy-manager` when managing the proxy service separately, or pass an
external manager with `--proxy-manager-url`. The standalone `npm start -- proxy`
command remains available for that setup.

Managed proxies are durable and reusable. For task/test isolation, create a
small pool of profiles and configure each browser with `proxyIds`.
Starting a browser selects one available proxy exclusively and starts its
Whistle process. Stopping preserves that reservation but stops Whistle when no
other live session uses it; destroying the browser releases the reservation.
The manager starts a stopped managed proxy idempotently when it is leased. Only explicit proxy deletion removes its
profile. Processes under the configured storage root that have no valid
pw-dev profile are treated as orphans; unrelated Whistle instances are not
stopped.
Compose the `ruleset` for the debugging job at hand: point app traffic at a
GUI devserver, mock API responses, inject local code, or combine those
behaviors in one durable proxy profile. Use a browser lease cursor when a task
needs a clean traffic window:

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

External proxy registrations are reusable routing metadata. Update a proxy
port by re-posting the same `id` with a different `proxyUrl`. Managed proxy
records mirror durable Whistle profiles and can include current runtime state;
the proxy manager and profile remain authoritative.
Use `brokerProxyForwardId` instead of `proxyUrl` when the broker owns the
forward, but do not set both fields.

Networks and SSH-peer forwarding are broker-owned advanced capabilities. Discover
them through the broker delegate at `/_pwdev/delegates/broker/openapi.json` and
use its `/_pwdev/broker/*` paths; pw-dev/server does not persist or restore them.

When the broker topology reports `remote: true` with `mode: "ssh"`, select the
managed proxy by `proxyId` when starting the browser. The broker maps the proxy
on its SSH peer automatically and reuses that mapping for later starts.

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/browser-configs \
  -H 'content-type: application/json' \
  -d '{"id":"checkout-chrome","ignoreSslErrors":true}'
curl -X POST http://127.0.0.1:9696/_pwdev/browsers \
  -H 'content-type: application/json' \
  -d '{"id":"checkout-tax","browserConfigId":"checkout-chrome","appId":"checkout-tax","proxyId":"whistle-main"}'
curl -X POST http://127.0.0.1:9696/_pwdev/browsers/checkout-tax/start
```

Do not create or pass `proxyForwardId` for normal browser starts; it is
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
Use `PATCH /_pwdev/apps/:id` only to change the app's `proxyId`; send `null` to
remove that attachment. `DELETE /_pwdev/apps/:id` removes the app record.

## Browser configs, browsers, and sessions

Create a persisted browser config, compose it into a browser, then start the
browser without a launch payload:

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/browser-configs \
  -H 'content-type: application/json' \
  -d '{"id":"checkout-chrome","targetUrl":"http://127.0.0.1:5174","profile":"checkout-tax","ignoreSslErrors":true}'
curl -X POST http://127.0.0.1:9696/_pwdev/browsers \
  -H 'content-type: application/json' \
  -d '{"id":"checkout-tax","browserConfigId":"checkout-chrome","appId":"checkout-tax"}'
curl -X POST http://127.0.0.1:9696/_pwdev/browsers/checkout-tax/start
```

The response contains a transient session with its `cdpUrl`. Attach Playwright
to that URL and navigate to `browser.components.browserConfig.targetUrl` when
present. Pass `lease` metadata in the start body to identify the agent running
the script:

```json
{
  "lease": { "owner": "agent-name", "agentId": "subagent-1", "taskId": "pw-task", "ttlMs": 30000 }
}
```

The response includes `session.lease.leaseId`. Heartbeat it with
`POST /_pwdev/sessions/:id/heartbeat` and `{ "leaseId": "..." }` while the
script runs, then release it with `POST /_pwdev/sessions/:id/release` when
done. A stale lease expires without stopping Chrome, and another agent can
claim the still-running session. Inspect `GET /_pwdev/browsers/:id` for
`status: "occupied"` plus `occupancy.owner`, `occupancy.taskId`, and
`occupancy.heartbeatAt`. Sessions are the
server's reconciled view of live broker instances; broker status remains the
source of truth. Stop the browser or its session explicitly:

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/browsers/checkout-tax/stop
curl -X POST http://127.0.0.1:9696/_pwdev/sessions/checkout-tax__default/stop
```

For parallel isolated instances, create multiple browsers that reference one
browser config. pw-dev derives a separate persistent profile for each browser:

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/browsers \
  -H 'content-type: application/json' \
  -d '{"id":"checkout-shard-1","browserConfigId":"checkout-chrome","appId":"checkout-tax"}'
curl -X POST http://127.0.0.1:9696/_pwdev/browsers/checkout-shard-1/start
```

To give concurrent tasks separate Whistle traffic contexts, configure a proxy
pool instead of one fixed `proxyId`:

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/browsers \
  -H 'content-type: application/json' \
  -d '{"id":"checkout-shard-1","browserConfigId":"checkout-chrome","appId":"checkout-tax","proxyIds":["checkout-traffic-a","checkout-traffic-b"]}'
```

Each active session receives `session.proxyLease`. Use its
`trafficStartTime` as the `startTime` query value when reading
`/_pwdev/proxies/:id/traffic`. Stopping preserves the browser's proxy
reservation and shuts down an idle Whistle process; destroying the browser
releases the reservation without deleting the durable
proxy profile.

Apps no longer own browser lifecycle. The retired
`/_pwdev/apps/:id/browser/*` routes return `410 Gone`.

## Browsers

A browser is a durable reusable browser suite. It references one required
browser config and may reference an app plus either one fixed proxy or a pool
of proxies. It also carries a workflow-specific `readme`.

The browser derives a stable Chrome profile from the browser config base
profile and browser id, for example:

```text
work-okta__checkout-smoke
```

The same browser can be stopped and started again without logging in again.
Only one session may occupy a browser. A proxy selected for a browser
is reserved for that browser even while its session is stopped. A proxy
pool selects one available proxy on first start and keeps that reservation.

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/browsers \
  -H 'content-type: application/json' \
  -d '{
    "id": "checkout-smoke",
    "browserConfigId": "checkout-browser",
    "appId": "checkout-main",
    "proxyIds": ["checkout-proxy-a", "checkout-proxy-b"],
    "readme": "Use the checkout test account; do not submit real orders."
  }'

curl http://127.0.0.1:9696/_pwdev/browsers/checkout-smoke
curl -X POST http://127.0.0.1:9696/_pwdev/browsers/checkout-smoke/start
curl -X POST http://127.0.0.1:9696/_pwdev/browsers/checkout-smoke/stop
curl -X DELETE http://127.0.0.1:9696/_pwdev/browsers/checkout-smoke
```

Stopping releases the broker instance but preserves the profile and proxy
reservation. Destroying stops the session, clears the derived broker profile,
releases the proxy reservation, and removes only the browser record. The
referenced app, proxy, and browser config remain reusable.

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

GET    /_pwdev/sessions
GET    /_pwdev/sessions/:id
POST   /_pwdev/sessions/:id/stop
POST   /_pwdev/sessions/:id/claim
POST   /_pwdev/sessions/:id/heartbeat
POST   /_pwdev/sessions/:id/release

GET    /_pwdev/apps
POST   /_pwdev/apps
GET    /_pwdev/apps/:id
PATCH  /_pwdev/apps/:id
DELETE /_pwdev/apps/:id
GET    /_pwdev/apps/:id/manifest

GET    /_pwdev/browser-configs
POST   /_pwdev/browser-configs
GET    /_pwdev/browser-configs/:id
DELETE /_pwdev/browser-configs/:id

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
