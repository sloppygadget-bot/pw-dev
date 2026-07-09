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
    Read-only local dashboard for pw-dev entities, status, and referers.

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

Playwright is intentionally optional. If the local environment should include a
ready Playwright client and Chromium browser, run:

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
  --app-url http://127.0.0.1:5173 \
  --profile checkout-main
```

By default the server probes the broker at `http://127.0.0.1:18080`. Use
`--broker-url` only when the broker runs somewhere else.

The server does not auto-register its root manifest in `/_pwdev/apps`.
Register apps explicitly with `POST /_pwdev/apps`; use
`--register-default-app` only for the older single-app convenience mode.

Start the optional proxy manager:

```bash
npm start -- proxy
```

`proxy` creates managed Whistle instances from rulesets supplied by an external
agent. Each instance gets separate proxy and GUI ports, isolated `-S` storage
under `packages/proxy/.runtime/whistle`, HTTPS capture enabled, a proxy
registry entry, and optionally an app `proxyId` attachment. Task-scoped managed
proxies can carry `taskId`, `owner`, `purpose`, and `labels` metadata for
client-side cleanup and filtering.
Shared proxies can be created without `appId`; pass the returned proxy id as
`proxyId` when starting each browser session that should use it.

Start the read-only local dashboard:

```bash
npm start -- gui --port 9797
```

The GUI server collects from `http://127.0.0.1:9696`,
`http://127.0.0.1:18080`, and `http://127.0.0.1:18081` by default. Override
those with `--pwdev-url`, `--broker-url`, and `--proxy-manager-url`.

Discovery endpoints:

```text
GET /_pwdev/manifest
GET /_pwdev/status
GET /_pwdev/instructions
GET /_pwdev/client.js
```

Agents should start with `GET /_pwdev/instructions` and `GET /_pwdev/status`.
The instructions endpoint is the machine-readable usage guide; status reports
whether the required broker component is configured and reachable. When the
broker was started with `--ssh`, broker status includes
`topology.remote: true` and `topology.mode: "ssh"` so agents can treat the SSH
peer as the broker's remote network side.

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

App registry and browser session endpoints:

```text
GET    /_pwdev/proxies
POST   /_pwdev/proxies
GET    /_pwdev/proxies/:id
DELETE /_pwdev/proxies/:id
GET    /_pwdev/networks
POST   /_pwdev/networks
GET    /_pwdev/networks/:id
DELETE /_pwdev/networks/:id
POST   /_pwdev/networks/:id/check
GET    /_pwdev/apps
POST   /_pwdev/apps
GET    /_pwdev/apps/:id
DELETE /_pwdev/apps/:id
GET    /_pwdev/apps/:id/manifest
GET    /_pwdev/apps/:id/browser/status
POST   /_pwdev/apps/:id/browser/start
POST   /_pwdev/apps/:id/browser/stop
ANY    /_pwdev/broker/*
GET    /_pwdev/proxy/status
GET    /_pwdev/proxy/proxies
POST   /_pwdev/proxy/proxies
GET    /_pwdev/proxy/proxies/:id
DELETE /_pwdev/proxy/proxies/:id
POST   /_pwdev/proxy/proxies/:id/stop
POST   /_pwdev/proxy/stop-all
```

Agents attach through the app manifest's `cdpUrl`. They only need the app
browser endpoints when asking `pw-dev` to start or stop broker sessions.
Broker APIs are proxied under `/_pwdev/broker/*`, so manifests can point CDP
at the pw-dev server instead of exposing the broker port.

Proxy registrations are reusable metadata only. They have no runner or status;
update a proxy port by re-posting the same proxy `id` with a new `proxyUrl`.
Networks are broker-owned browser routing profiles. Prefer `networkId` for new
browser-start workflows; the broker resolves it to Chrome launch options and
owns any SSH proxy forward needed for `ssh-peer` networks.
`accounts` is metadata for non-production test accounts only. Do not register
production accounts, personal credentials, or sensitive tokens.

Browser start accepts task metadata so agents and humans can see why a browser
session exists. With `task.id`, the server creates a task-scoped browser session
under the same app and uses profile `<app id>__<task id>` unless `profile` is
explicitly supplied:

```json
{
  "task": {
    "id": "smoke-login-20260629",
    "label": "Smoke login flow",
    "owner": "codex"
  }
}
```

The start response includes `session.cdpUrl` for task-scoped starts. Agents
should attach to that URL, or to `app.cdpUrl` for a default no-task browser.

Duplicate starts for the same default slot or same `task.id` return
`409 Conflict`. Agents should end completed task sessions explicitly with
`POST /_pwdev/apps/:id/browser/stop` and a `taskId` body; app registrations and
persistent profiles remain available for later tasks.

## Tests

```bash
npm test
```

## Implementation Standard

- Plain ESM JavaScript.
- No build step.
- No transpiler.
- No TypeScript until the public API stabilizes.
- Public APIs should have JSDoc typedefs.
- Runtime inputs must be validated explicitly.
- Tests use Node's built-in `node:test`.
- Avoid npm dependencies unless they remove substantial complexity.
