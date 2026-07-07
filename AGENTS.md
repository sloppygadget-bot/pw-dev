# AGENTS.md

Guidance for agents working in this repository.

## Project Overview

`pw-dev` is a dependency-light Playwright/Chrome dev tooling workspace. The
main runtime pieces are:

- `@pw-dev/cdp-broker`: owns Chrome/Chromium sessions, persistent profiles, and
  CDP forwarding.
- `@pw-dev/server`: agent-facing control plane for app registration, status,
  browser lifecycle, and broker/proxy forwarding.
- `@pw-dev/proxy`: optional Whistle proxy manager.
- `@pw-dev/cli`: root dispatcher for `pw-dev broker`, `pw-dev server`, and
  `pw-dev proxy`.

Use Node 18+.

## Install

```bash
npm install
```

Playwright is optional. If a task needs local Playwright code or Chromium
installed in this workspace, run:

```bash
npm run install:playwright
```

Generated Playwright task files should stay under:

```text
.agent/tasks/<task-id>/run.mjs
.agent/tasks/<task-id>/artifacts/
```

## Start The Broker

Start the broker before using server-managed browser lifecycle routes:

```bash
npm start -- broker --standby
```

Default broker URL:

```text
http://127.0.0.1:18080
```

For a named persistent browser profile:

```bash
npm start -- broker --profile work-okta
```

The broker has no npm dependencies. For a minimal remote setup, clone and run
the broker directly without `npm install`:

```bash
git clone https://github.com/sloppygadget-bot/pw-dev.git && cd pw-dev && node packages/cdp-broker/bin/pw-cdp-broker.js --standby --ssh user@target-server
```

For an existing checkout, the same SSH broker command is:

```bash
node packages/cdp-broker/bin/pw-cdp-broker.js --standby --ssh user@target-server
```

Direct CDP attach example:

```js
const browser = await chromium.connectOverCDP('http://127.0.0.1:18080');
```

Broker help is available only after the broker is running:

```bash
curl http://127.0.0.1:18080/_broker/help
```

## Start The Server

Start the agent-facing server:

```bash
npm start -- server --port 9696
```

The server also has no npm dependencies. To run it directly after cloning:

```bash
git clone https://github.com/sloppygadget-bot/pw-dev.git && cd pw-dev && node packages/server/bin/pw-dev-server.js --port 9696
```

Default server URL:

```text
http://127.0.0.1:9696
```

The server probes the default broker at `http://127.0.0.1:18080`. Only pass
`--broker-url` when the broker is running somewhere else:

```bash
npm start -- server --port 9696 --broker-url http://127.0.0.1:18080
```

To serve or register a specific app, include app metadata:

```bash
npm start -- server \
  --root examples/static-site \
  --app-url http://127.0.0.1:5173 \
  --id checkout-main \
  --profile checkout-main
```

## Basic Agent Usage

After the server is running, treat its live discovery endpoints as the source
of truth for API details. Start with:

```bash
curl http://127.0.0.1:9696/_pwdev/status
curl http://127.0.0.1:9696/_pwdev/instructions
```

`/_pwdev/instructions` is the machine-readable usage guide exposed by the
running server. Do not rely on stale hardcoded API assumptions when the server
can provide current instructions.

Useful discovery endpoints:

```text
GET /_pwdev/status
GET /_pwdev/instructions
GET /_pwdev/apps
GET /_pwdev/apps/:id/manifest
GET /_pwdev/client.js
```

Typical flow:

1. Start broker with `npm start -- broker --standby`.
2. Start server with `npm start -- server --port 9696`.
3. Fetch `GET /_pwdev/status` and verify the broker is configured and reachable.
4. Fetch `GET /_pwdev/instructions` for current API usage.
5. Fetch an app manifest and attach Playwright to the returned `cdpUrl`.

Agents should connect to the `cdpUrl` returned by pw-dev. Do not launch a
separate browser unless the task explicitly requires it.

## Optional Proxy Manager

Start the proxy manager only when a task needs managed Whistle proxies:

```bash
npm start -- proxy
```

Default proxy manager URL:

```text
http://127.0.0.1:18081
```

The server proxies proxy-manager APIs under `/_pwdev/proxy/*`.

Managed Whistle proxies start with HTTPS capture enabled (`Enable HTTPS /
Capture Tunnel Traffic`).

Most managed proxies should be task-scoped: create one for a specific
test/verification, start the browser with that `proxyId`, then delete the proxy
when the task ends. To create a live managed proxy, send
`POST /_pwdev/proxy/proxies` with `ruleset` and either `id` or `appId`. If only
`appId` is supplied, the proxy id defaults to `<appId>-whistle`.

Shared managed proxies do not need an `appId`; pass the returned proxy id as
`proxyId` in each browser start request or app registration that should use it.
Agents can tag proxies with optional tracking fields: `taskId`, `owner`,
`purpose`, and `labels`.

## References

- `README.md`: quick start and package overview.
- `docs/server.md`: server API and agent lifecycle guide.
- `docs/architecture.md`: component diagrams and runtime flow.
- `packages/cdp-broker/README.md`: detailed broker behavior.
