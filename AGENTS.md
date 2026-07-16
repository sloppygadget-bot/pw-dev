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

Initialize the server origin for client-agent handoff:

```bash
export PW_DEV_URL="${PW_DEV_URL:-http://127.0.0.1:9696}"
```

### Server lifecycle

Run the server in the foreground during local work. The server-owned proxy
manager starts lazily on the first server-proxied proxy operation. Press
`Ctrl-C` to stop the server gracefully; any manager it started is stopped with
it. To restart, stop the existing server and run the same command again:

```bash
npm start -- server --port 9696
```

When the server is backgrounded, send `SIGTERM` to the server process for a
graceful stop, then start it again. Do not start or stop the internal proxy
manager separately unless the server was explicitly configured with
`--no-proxy-manager`.

The server also has no npm dependencies. To run it directly after cloning:

```bash
git clone https://github.com/sloppygadget-bot/pw-dev.git && cd pw-dev && node packages/server/bin/pw-dev-server.js --port 9696
```

Default server URL:

```text
$PW_DEV_URL
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
  --id checkout-main
```

## Basic Agent Usage

The launcher should pass the server origin to the client agent as
`PW_DEV_URL`. The client agent should not need any pw-dev knowledge beyond
that URL. After the server is running, treat its live discovery endpoints as
the source of truth for API details. Start with:

```bash
curl "$PW_DEV_URL/_pwdev/status"
curl "$PW_DEV_URL/_pwdev/instructions"
```

`/_pwdev/instructions` is the machine-readable usage guide exposed by the
running server. Do not rely on stale hardcoded API assumptions when the server
can provide current instructions.

Use the server-origin APIs under `$PW_DEV_URL/_pwdev/*`. Do not connect to
internal broker or proxy-manager ports directly.

For the complete discovery sequence, endpoint list, browser workflow, and
Playwright examples, fetch `GET $PW_DEV_URL/_pwdev/instructions`. The client
helper source is available at `GET $PW_DEV_URL/_pwdev/client.js`.

At a high level, start the broker, start the server, verify
`GET $PW_DEV_URL/_pwdev/status`, then follow the live instructions to select an
app and attach Playwright to its returned `cdpUrl`.

Agents should connect to the `cdpUrl` returned by pw-dev. Do not launch a
separate browser unless the task explicitly requires it.

## References

- `README.md`: quick start and package overview.
- `docs/server.md`: server API and agent lifecycle guide.
- `docs/architecture.md`: component diagrams and runtime flow.
- `packages/cdp-broker/README.md`: detailed broker behavior.
