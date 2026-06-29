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

  cli/
    Root command dispatcher for `pw-dev broker` and `pw-dev server`.
```

See [docs/architecture.md](docs/architecture.md) for the component diagrams,
runtime flow, multi-app registry flow, and agent/server/broker contracts. See
[docs/server.md](docs/server.md) for the server API and agent lifecycle guide.

## Install

```bash
npm install
```

There are currently no npm runtime dependencies. System requirements are Node
18+, a Chromium-family browser for broker mode, and OpenSSH only when using SSH
tunnel features.

## Run The Broker

```bash
npm run broker -- --profile work-okta
```

Or through the root CLI:

```bash
npm start -- broker --profile work-okta
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

Discovery endpoints:

```text
GET /_pwdev/manifest
GET /_pwdev/status
GET /_pwdev/instructions
GET /_pwdev/client.js
```

Agents should start with `GET /_pwdev/instructions` and `GET /_pwdev/status`.
The instructions endpoint is the machine-readable usage guide; status reports
whether the required broker component is configured and reachable.

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
GET    /_pwdev/apps
POST   /_pwdev/apps
GET    /_pwdev/apps/:id
DELETE /_pwdev/apps/:id
GET    /_pwdev/apps/:id/manifest
GET    /_pwdev/apps/:id/browser/status
POST   /_pwdev/apps/:id/browser/start
POST   /_pwdev/apps/:id/browser/stop
ANY    /_pwdev/broker/*
```

Agents attach through the app manifest's `cdpUrl`. They only need the app
browser endpoints when asking `pw-dev` to start or stop broker sessions.
Broker APIs are proxied under `/_pwdev/broker/*`, so manifests can point CDP
at the pw-dev server instead of exposing the broker port.

Proxy registrations are reusable metadata only. They have no runner or status;
update a proxy port by re-posting the same proxy `id` with a new `proxyUrl`.
`accounts` is metadata for non-production test accounts only. Do not register
production accounts, personal credentials, or sensitive tokens.

Browser start accepts task metadata so agents and humans can see why a browser
session exists:

```json
{
  "task": {
    "id": "smoke-login-20260629",
    "label": "Smoke login flow",
    "owner": "codex"
  }
}
```

If an app already has an active browser task, another `browser/start` returns
`409 Conflict`. Agents should end completed tasks explicitly with
`POST /_pwdev/apps/:id/browser/stop`; app registrations and persistent profiles
remain available for later tasks.

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
