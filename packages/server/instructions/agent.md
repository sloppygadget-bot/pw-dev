# pw-dev agent instructions

Use only this server's `/_pwdev/*` APIs. Do not call broker or proxy-manager
ports directly.

## Discover

```bash
curl '{{SERVER_URL}}/_pwdev/status'
curl '{{SERVER_URL}}/_pwdev/openapi.json'
```

`status` reports broker reachability. The root OpenAPI document is a compact
catalog: read its `x-pwdev-documents` list, then fetch only the domain document
needed next. `env` is optional runtime-path discovery for shell/external
tooling; fetch it again after a server restart.

For managed-proxy lifecycle or rules, first fetch `GET /_pwdev/delegates` and
then the proxy delegate's linked OpenAPI document. The server republishes that
component-owned contract under `/_pwdev/proxy/*`; do not call its internal port.

## Persisted entities

- **app**: project metadata, `readme`, accounts, and worktree. An app can be
  linked from a browser but does not own browser lifecycle.
- **proxy**: reusable proxy configuration; managed proxy rules/profile state are
  retained in the in-house Whistle profile. Stop and release preserve it;
  explicit proxy deletion is the destructive operation.
- **browserConfig**: reusable Chrome launch configuration. Fields include `id`,
  optional `targetUrl`, `brokerUrl`, `profile`, `proxyBypassList`,
  `ignoreSslErrors`, and `headless`. A browser config cannot be started directly.
  Do not edit a config referenced by a browser; deletion is blocked while it is
  referenced or occupied by a live session.
- **browser**: durable reusable browser. It requires one
  `browserConfigId`, may reference one `appId`, and may reserve either one
  `proxyId` or select one exclusively from a `proxyIds` pool. It also carries a
  browser-specific `readme` for workflow instructions.

## Browsers

Read the browser record and its `readme` before starting it:

```bash
curl '{{SERVER_URL}}/_pwdev/browsers/checkout-smoke'
curl -X POST '{{SERVER_URL}}/_pwdev/browsers/checkout-smoke/start'
```

A browser derives a stable Chrome profile from its browser config and
browser id. Restarting the same browser preserves its login state.
Only one session may occupy a browser. A selected proxy remains reserved
by the browser when its session is stopped; it is released only when the
browser is destroyed. A `proxyIds` pool selects one available proxy when
the browser first starts.

Attach Playwright to `response.session.cdpUrl`. Stop the session with:

```bash
curl -X POST '{{SERVER_URL}}/_pwdev/browsers/checkout-smoke/stop'
```

Destroying a browser stops its session, clears its derived broker profile,
releases its proxy reservation, and deletes only the browser record. The
referenced app, proxy, and browser config remain reusable.

## Start and use a browser

Create a persistent **browserConfig**, then create a **browser** that references
it. Put optional app and proxy composition on the browser:

```bash
curl -X POST '{{SERVER_URL}}/_pwdev/browser-configs' \
  -H 'content-type: application/json' \
  -d '{"id":"docs-chrome","headless":true}'
curl -X POST '{{SERVER_URL}}/_pwdev/browsers' \
  -H 'content-type: application/json' \
  -d '{"id":"docs-crawler","browserConfigId":"docs-chrome"}'
```

Start the browser, claim its session, and connect to it. A browser's
`status: "occupied"` means Chrome is running; the session `lease` identifies
which Playwright agent currently owns automation. Use a heartbeat at least
every few seconds so a crashed agent's claim expires automatically:

```js
const started = await fetch('{{SERVER_URL}}/_pwdev/browsers/docs-crawler/start', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    lease: { owner: 'agent-name', agentId: 'subagent-1', taskId: 'playwright-task' },
  }),
}).then((response) => response.json());

const browser = await chromium.connectOverCDP(started.session.cdpUrl);
const leaseId = started.session.lease.leaseId;
const heartbeat = setInterval(() => fetch(
  `{{SERVER_URL}}/_pwdev/sessions/${started.session.sessionId}/heartbeat`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leaseId }) },
), 10_000);
// Navigate to the browser config's targetUrl when one is configured.
```

If the browser was started without a lease, claim it with
`POST /_pwdev/sessions/:id/claim` and `{ "owner": "agent-name" }`. A claim by
another live owner returns `409`; inspect `GET /_pwdev/browsers/:id` to see
`occupancy.owner`, `taskId`, and the last heartbeat. Release the lease with
`POST /_pwdev/sessions/:id/release` and `{ "leaseId": "..." }` when the script
ends, then clear the heartbeat timer.

For parallel work, create multiple browsers that reference the same browser
config. Each browser owns at most one transient session. When a browser has
`proxyIds`, it selects and reserves the first available proxy. The session
includes `proxyLease`; use its `proxyId`
and `trafficStartTime` with
`GET /_pwdev/proxies/:id/traffic?startTime=<trafficStartTime>` for a clean
lease-scoped traffic window. Stopping the session releases the lease without
stopping or deleting the durable proxy profile. Pool exhaustion returns 409.
Leases are transient session state, so stop active sessions before restarting
the pw-dev server.

Starting a browser creates a transient **session**. Broker state is authoritative;
the server removes a session when broker status no longer reports its instance.
Stop with `POST /_pwdev/browsers/:id/stop` or
`POST /_pwdev/sessions/:id/stop`. Detach Playwright with `browser.close()` when
automation ends; that disconnects the client without stopping the instance.

For a remote SSH broker, when the selected `proxyId` resolves to a proxy URL,
pw-dev asks the broker to create or reuse the required mapping. Do not create
proxy forwards yourself; a proxy record that already has a broker forward uses
that existing forward.

## Example workflows

### App-based

1. Register the app with `POST /_pwdev/apps`. Put operational guidance in
   `readme`: devserver start/stop commands, environment setup, and the proxy
   rule template plus its compose/compile method.
2. Read that app `readme`, compose the rules, then create one or more durable
   managed proxies with `POST /_pwdev/proxy/proxies`.
3. Create a browser config with `POST /_pwdev/browser-configs`.
4. Create a browser with `POST /_pwdev/browsers`, linking the config through
   `browserConfigId` and optionally linking the app and proxy configuration.
5. Start it with `POST /_pwdev/browsers/:id/start`; attach Playwright to the
   returned session `cdpUrl`.

### Standalone

1. Create one or more managed proxies with `POST /_pwdev/proxy/proxies` and no
   `appId`.
2. Create a browser config with the desired launch settings.
3. Create a browser that references it; optionally set `proxyId` or `proxyIds`.
4. Start it with `POST /_pwdev/browsers/:id/start`; attach Playwright to the
   returned session `cdpUrl`.

## API documents

<!-- Generated from OpenAPI. Do not add API links manually. -->
{{API_DOCUMENTS}}

## Control-plane endpoint summary

<!-- Generated from OpenAPI. Update the schemas, not this template. -->
{{API_ENDPOINTS}}

App-scoped `/_pwdev/apps/:id/browser/*` routes are retired.
