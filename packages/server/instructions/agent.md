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
- **browserTpl**: reusable launch template. Fields include `id`, optional
  `appId`, `targetUrl`, `brokerUrl`, `profile`, either fixed `proxyId` or pooled
  `proxyIds`, `proxyBypassList`, `ignoreSslErrors`, and `headless`.

## Start and use a browser

Create or update a persistent **browserTpl** with `POST /_pwdev/browsers`.
Start its default session without a payload, or start an isolated concurrent
session with a `sessionId` (which receives its own profile by default):

```js
const started = await fetch('{{SERVER_URL}}/_pwdev/browsers/docs-crawler/start', {
  method: 'POST',
}).then((response) => response.json());

const browser = await chromium.connectOverCDP(started.session.cdpUrl);
// Navigate to the template's targetUrl when one is configured.
```

For parallel work, send `{ "sessionId": "shard-1" }` to start and stop:
`POST /_pwdev/browsers/:id/start` and `POST /_pwdev/browsers/:id/stop`. Named
sessions are transient and appear in `GET /_pwdev/sessions`.

When a template has `proxyIds`, each active session exclusively leases the
first available proxy. The response includes `proxyLease`; use its `proxyId`
and `trafficStartTime` with
`GET /_pwdev/proxies/:id/traffic?startTime=<trafficStartTime>` for a clean
lease-scoped traffic window. Stopping the session releases the lease without
stopping or deleting the durable proxy profile. Pool exhaustion returns 409.
Leases are transient session state, so stop active sessions before restarting
the pw-dev server.

The response creates a transient **session**. Broker state is authoritative;
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
3. Create a browser template with `POST /_pwdev/browsers`, using `appId` and
   either one fixed `proxyId` or a reusable `proxyIds` pool.
4. Start it with `POST /_pwdev/browsers/:id/start`; attach Playwright to the
   returned session `cdpUrl`.

### Standalone

1. Create one or more managed proxies with `POST /_pwdev/proxy/proxies` and no
   `appId`.
2. Create a browser template with `targetUrl` and either `proxyId` or
   `proxyIds`.
3. Start it with `POST /_pwdev/browsers/:id/start`; attach Playwright to the
   returned session `cdpUrl`.

## API documents

<!-- Generated from OpenAPI. Do not add API links manually. -->
{{API_DOCUMENTS}}

## Control-plane endpoint summary

<!-- Generated from OpenAPI. Update the schemas, not this template. -->
{{API_ENDPOINTS}}

App-scoped `/_pwdev/apps/:id/browser/*` routes are retired.
