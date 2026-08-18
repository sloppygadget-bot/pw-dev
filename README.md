# pw-dev

Dependency-light Playwright/Chrome dev tooling.

This repo is organized as plain ESM JavaScript packages with no build step. The
first real component is the existing local/remote browser broker from
`../pw-cdp-broker`, copied into this workspace as `@pw-dev/cdp-broker`.

## Packages

```text
packages/
  cdp-broker/
    Local Chrome session broker with persistent profiles, CDP forwarding,
    optional SSH tunnels, and remote lifecycle endpoints.

  server/
    Thin dependency-free dev server wrapper. Static files, health, and
    /_pwdev discovery endpoints without pulling Playwright into the base.

  proxy/
    Optional Whistle process manager for external-agent supplied rulesets.

  gui/
    Local dashboard for pw-dev entities, status, browser CRUD, and sessions.

  cli/
    Root command dispatcher for `pw-dev broker`, `pw-dev server`,
    `pw-dev proxy`, and `pw-dev gui`.
```

See [docs/architecture.md](docs/architecture.md) for the component diagrams,
runtime flow, multi-app registry flow, and agent/server/broker contracts. See
[docs/server.md](docs/server.md) for the server API and agent lifecycle guide.

## Install

```bash
npm install
```

Runtime dependencies are kept narrow; `@pw-dev/proxy` carries Whistle so it can
start managed proxy instances without a global `w2`. System requirements are
Node 18+, a Chromium-family browser for broker mode, and OpenSSH only when
using SSH tunnel features.

The Playwright client, CLI, Chromium browser, and bundled probing skills are
installed automatically by `npm install`. To repeat that setup explicitly, run:

```bash
npm run install:playwright
```

Agent-generated Playwright task code should run inside this workspace so it
uses the Playwright package shipped with pw-dev. Keep generated task files under
`.agent/tasks/<task-id>/run.mjs` and artifacts under
`.agent/tasks/<task-id>/artifacts/`. Task outputs are ignored by git.

That is the default location. If you want to run the script against another
Playwright install, you can copy it elsewhere.

## Run The Broker

```bash
npm run broker -- --profile work-okta
```

Or through the root CLI:

```bash
npm start -- broker --profile work-okta
```

For an SSH-backed broker, run the broker entrypoint directly:

```bash
node packages/cdp-broker/bin/pw-cdp-broker.js --standby --ssh user@target-server
```

Connect from Playwright:

```js
const browser = await chromium.connectOverCDP('http://127.0.0.1:18080');
```

## Run The Server

```bash
npm start -- server \
  --root examples/static-site \
  --port 9696
```

Expose app metadata for agents:

```bash
npm start -- server \
  --root examples/static-site \
  --app-url http://127.0.0.1:5173
```

By default the server probes the broker at `http://127.0.0.1:18080`. Use
`--broker-url` only when the broker runs somewhere else.

Provision a remote Linux broker through the running server. Prefer a stored
remote-host asset so server-owned reconnects use a stable key identity:

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/remote-brokers \
  -H 'content-type: application/json' \
  -d '{"id":"lab","hostId":"lab-linux","remotePort":18080,"localPort":18081}'
```

The remote checkout defaults to `~/.pw-dev/pw-dev`, is compared with the
server's Git revision before reuse/update, and is exposed through a
server-owned local port in `18080-18089`. Here `localPort: 18081` forwards to
the broker's loopback-only `remotePort: 18080`. The server monitors and reconnects
dead SSH forwards. See [docs/server.md](docs/server.md#remote-linux-brokers)
for cleanup and remote-stop behavior.

The server does not auto-register its root manifest in `/_pwdev/apps`.
Register apps explicitly with `POST /_pwdev/apps`; use
`--register-default-app` only for the older single-app convenience mode.
App registrations persist under `<worktree>/.pw-dev/apps.json` by default,
while active browser sessions remain broker-owned and are not restored after a
server restart. Use an app registration's `readme` field for agent operating
instructions, including devserver/environment setup and, when relevant, the
proxy-rule template and composition method.
Managed proxy rules and configuration live in that proxy's Whistle profile
directory. Control a persisted managed proxy through
`POST /_pwdev/proxy/proxies/:id/start`, `.../:id/stop`, or `.../:id/restart`.

The server starts the local proxy manager lazily on the first proxied proxy
operation and stops it with the server on `http://127.0.0.1:9697`. Use
`--no-proxy-manager` when managing that service separately; an external manager
can be supplied with `--proxy-manager-url`. The standalone
`npm start -- proxy` command remains available for that case.

The proxy manager creates durable managed Whistle profiles from rulesets supplied by
an external agent. Each profile gets separate proxy and GUI ports, isolated
`-S` storage under `packages/proxy/.runtime/whistle`, HTTPS capture enabled, a
proxy registry entry, and optionally an app `proxyId` attachment. Whistle stays
stopped until a browser that references the profile starts, then stops again
when no live browser session uses it. The in-house
Whistle profile is the durable source of truth: stopping the process, stopping
the manager, or releasing a browser lease preserves configuration, rules, and
traffic. Only `DELETE /_pwdev/proxy/proxies/:id` removes the profile.

For task-isolated traffic, create several managed profiles without `appId` and
put their ids in a browser's `proxyIds`. Each browser selects and reserves one
available proxy until that browser is destroyed.
The returned `proxyLease.trafficStartTime` can be passed to the proxy traffic
endpoint as `startTime` to read traffic from that lease boundary.

Start the local dashboard:

```bash
npm start -- gui --port 9797
```

The GUI server collects from `http://127.0.0.1:9696`,
`http://127.0.0.1:18080`, and `http://127.0.0.1:9697` by default. It also
scans localhost ports `18080` through `18089` for additional ready brokers;
discovered brokers appear in the Brokers view and can be used to prefill a
browser config. Override the primary endpoints with `--pwdev-url`,
`--broker-url`, and `--proxy-manager-url`.

When a browser has a live session, its GUI `Monitor` action opens
`/monitor/<browser-id>` in a new tab. The monitor attaches to that existing
session over CDP and reconstructs a searchable live DOM mirror with
stylesheets, viewport, scroll state, DOM patches, and safe element
highlight/click/focus actions. It does not launch another browser.

Discovery endpoints:

```text
GET /_pwdev/manifest
GET /_pwdev/status
GET /_pwdev/env
GET /_pwdev/instructions
GET /_pwdev/client.js
GET /_pwdev/openapi.json
GET /_pwdev/openapi/*
GET /_pwdev/delegates
```

Agents should start with `GET /_pwdev/instructions` and `GET /_pwdev/status`.
The instructions endpoint is the machine-readable usage guide; status reports
whether the required broker component is configured and reachable. When the
broker was started with `--ssh`, broker status includes
`topology.remote: true` and `topology.mode: "ssh"` so agents can treat the SSH
peer as the broker's remote network side. Every broker reports
`topology.localMachine` for the host where it runs. Server-owned remote brokers
are shown as `ssh/outward`; ordinary SSH broker topology defaults to `ssh/inward`.

`GET /_pwdev/openapi.json` is the compact progressive-discovery catalog. Read
its `x-pwdev-documents` links and fetch only the relevant domain document, such
as `GET /_pwdev/openapi/browser-configs.json` or `GET /_pwdev/openapi/proxies.json`.
For proxy-manager lifecycle or rules, first read `GET /_pwdev/delegates`, then
fetch the proxy delegate's linked OpenAPI document. Agents use its declared
`/_pwdev/proxy/*` paths, never the proxy-manager port directly.

Register reusable proxy metadata with the central server:

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

Register parallel branch apps with the central server:

```bash
curl -X POST http://127.0.0.1:9696/_pwdev/apps \
  -H 'content-type: application/json' \
  -d '{
    "id": "fortisase-dev",
    "name": "FortisASE dev",
    "worktree": "/home/me/work/fortisase",
    "branch": "main",
    "appUrl": "https://dev.fortisase-sovereign.com",
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

Use `GET /_pwdev/apps/:id` to inspect an app, `PATCH /_pwdev/apps/:id` to
change only its `proxyId` attachment, and `DELETE /_pwdev/apps/:id` to remove
the registration.

App registry and browser session endpoints:

```text
GET    /_pwdev/proxies
POST   /_pwdev/proxies
GET    /_pwdev/proxies/:id
DELETE /_pwdev/proxies/:id
GET    /_pwdev/proxies/:id/traffic
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
GET    /_pwdev/sessions
GET    /_pwdev/sessions/:id
POST   /_pwdev/sessions/:id/stop
POST   /_pwdev/sessions/:id/claim
POST   /_pwdev/sessions/:id/heartbeat
POST   /_pwdev/sessions/:id/release
ANY    /_pwdev/broker/*
GET    /_pwdev/proxy/status
GET    /_pwdev/proxy/proxies
POST   /_pwdev/proxy/proxies
GET    /_pwdev/proxy/proxies/:id
PUT    /_pwdev/proxy/proxies/:id/rules
DELETE /_pwdev/proxy/proxies/:id
POST   /_pwdev/proxy/proxies/:id/stop
POST   /_pwdev/proxy/stop-all
```

Read a managed Whistle proxy's captured traffic through the pw-dev server:

```bash
curl 'http://127.0.0.1:9696/_pwdev/proxies/smoke-login-proxy/traffic?dumpCount=100&url=%2Fapi%2Forders'
```

The response contains Whistle's Network feed in `traffic`. `url`, `ip`, and
up to six request-header filters (`name`/`value` through `name5`/`value5`) are
supported; use `mtype=1` for exact header values. Use the returned
`traffic.data.lastId` as `startTime` to poll for later entries.

Agents attach through the `session.cdpUrl` returned by a browser start.
Use `/_pwdev/browsers/*` and `/_pwdev/sessions/*` for ordinary lifecycle work.
Broker APIs are proxied under `/_pwdev/broker/*`, so the returned CDP URL can
point at the pw-dev server instead of exposing the broker port.

External proxy registrations are reusable routing metadata; update a port by
re-posting the same proxy `id` with a new `proxyUrl`. Managed proxy records are
durable Whistle-profile mirrors and may also expose current runtime state; the
proxy manager and profile remain authoritative.
When a broker reports SSH remote topology, selecting a registered proxy by
`proxyId` automatically creates or reuses a broker-owned SSH mapping. Agents do
not need proxy-forward IDs or mapped ports.
`accounts` is metadata for non-production test accounts only. Do not register
production accounts, personal credentials, or sensitive tokens.

For isolated parallel work, create multiple browsers that reference one
browser config. Each browser can optionally link an app and fixed or pooled
proxy configuration:

```json
{
  "id": "smoke-login-20260629",
  "browserConfigId": "checkout-chrome",
  "appId": "checkout-main",
  "proxyIds": ["traffic-a", "traffic-b"]
}
```

The browser start response includes `session.cdpUrl`; attach Playwright to that
URL. Include `{ "lease": { "owner": "agent-name", "taskId": "pw-task" } }`
in the start body to make the Playwright owner visible to other agents. The
session returns an opaque `leaseId`; heartbeat it through
`POST /_pwdev/sessions/:id/heartbeat` while the script runs and release it with
`POST /_pwdev/sessions/:id/release` when done. `GET /_pwdev/browsers/:id`
reports `status: "occupied"` and the current `occupancy` owner/task/heartbeat;
an expired lease is reclaimable without stopping Chrome. When the browser
selects a proxy, the session also records that lease.

Duplicate starts for the same browser return `409 Conflict`. End completed
sessions explicitly with `POST /_pwdev/browsers/:id/stop`; app registrations,
browser profiles, browser configs, and
managed proxy profiles remain available for later work.

## Tests

```bash
npm run check:kb
npm test
```

`check:kb` validates the OpenAPI catalogs and links, instruction templates,
local Markdown links, documented npm commands, and the live rendered discovery
endpoints against an ephemeral server.

## Implementation Standard

- Plain ESM JavaScript.
- No build step.
- No transpiler.
- No TypeScript until the public API stabilizes.
- Public APIs should have JSDoc typedefs.
- Runtime inputs must be validated explicitly.
- Tests use Node's built-in `node:test`.
- Avoid npm dependencies unless they remove substantial complexity.
