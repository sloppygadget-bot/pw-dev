# pw-dev Architecture

`pw-dev` separates app serving, browser ownership, and browser operation.

- The app is the actual development target.
- `@pw-dev/server` is the central app registry, paired with a broker, and gives tools stable URLs.
- `@pw-dev/cdp-broker` owns local Chrome, persistent profiles, and CDP access.
- `@pw-dev/proxy` is optional. It starts/stops managed Whistle proxy processes
  from external-agent rulesets, while the server proxies its API.
- A human, or the agent/CLI they run, operates Chrome through the
  broker-backed session.

## Components

```mermaid
flowchart LR
  Human["Human developer<br/>or agent/CLI they run"]
  App["App devserver<br/>http://127.0.0.1:5173"]
  Server["pw-dev/server<br/>persisted control plane + CDP proxy"]
  AppRecord["App record<br/>worktree + README + accounts"]
  BrowserTemplate["Browser template<br/>targetUrl + profile + network/proxy"]
  Session["Transient session<br/>cdpUrl + broker instance"]
  Network["Network record<br/>broker-owned routing config"]
  Proxy["Proxy record<br/>ruleset / proxy URL"]
  ProxyManager["pw-dev/proxy<br/>managed Whistle process manager"]
  Whistle["Whistle proxy<br/>port pool 8888-8899"]
  Broker["pw-dev/broker<br/>profile + CDP endpoint"]
  Chrome["Chrome<br/>persistent profile"]

  Human -->|starts app| App
  Human -->|starts central registry| Server
  Human -->|starts on demand| ProxyManager
  Human -->|starts with profile| Broker

  Server -->|persists| AppRecord
  Server -->|persists| BrowserTemplate
  Server -->|persists| Network
  Server -->|persists| Proxy
  AppRecord -. optional appId .-> BrowserTemplate
  BrowserTemplate -->|start using targetUrl + launch config| Server
  Server -->|recreates network; resolves proxy; starts| Broker
  Broker -->|reports live instance| Session
  Server -->|reconciles; proxies cdpUrl| Session
  BrowserTemplate -. produces .-> Session
  Server -->|proxies /_pwdev/proxy/*| ProxyManager
  Proxy -->|managed config| ProxyManager
  ProxyManager -->|starts/stops| Whistle

  Broker -->|launches / keeps alive| Chrome
  Chrome -->|loads browser targetUrl| App

  Human -->|manual login / recovery| Chrome
```

## Runtime Flow

```mermaid
sequenceDiagram
  participant Human as Human / agent CLI
  participant App as App devserver
  participant Server as pw-dev/server
  participant Broker as pw-dev/broker
  participant Chrome as Chrome

  Human->>App: start app devserver on app port
  Human->>Server: start central pw-dev server paired with brokerUrl
  Human->>Server: POST /_pwdev/apps with worktree and operating README
  Human->>Server: POST /_pwdev/browsers with appId, targetUrl, profile, and network/proxy metadata
  Human->>Server: POST /_pwdev/browsers/:id/start
  Server->>Broker: POST /_broker/start with persistent profile/proxy metadata
  Broker->>Chrome: launch Chrome with persistent user-data-dir
  Human->>Chrome: complete login/MFA if needed

  Server-->>Human: transient session with proxied cdpUrl

  Human->>Server: connectOverCDP(cdpUrl)
  Server->>Broker: proxy CDP HTTP/WebSocket
  Broker-->>Server: CDP browser connection
  Server-->>Human: CDP browser connection

  Human->>Chrome: reuse or open page
  Chrome->>App: load browser targetUrl
  Human->>Chrome: inspect DOM, click, screenshot, smoke flow

  Human-->>Broker: detach automation client
  Broker-->>Chrome: keep browser/profile alive
  Human->>Chrome: continue manual work if needed
```

## Multi-App Flow

For multiple worktrees, each app has its own app devserver. A central
`pw-dev/server` registry tracks persisted apps and browser templates. By
default they share one `pw-dev/broker` process. The server asks the broker to
start one Chrome instance/profile per browser-template session; the returned
server-proxied, instance-scoped CDP URL belongs to the transient session, not
the app or template.

```mermaid
flowchart TD
  Human["Human developer<br/>or agent/CLI they run"]
  Server["central pw-dev/server<br/>persisted entities + CDP proxy"]
  Broker["shared pw-dev/broker<br/>http://127.0.0.1:18080"]

  subgraph WorktreeA["worktree: checkout-main"]
    AppA["App devserver A<br/>http://127.0.0.1:5173"]
    TemplateA["Browser template A<br/>targetUrl + profile/network/proxy"]
    SessionA["Transient session A<br/>cdpUrl → bkr_a"]
    ChromeA["Chrome instance A<br/>profile: checkout-main"]
  end

  subgraph WorktreeB["worktree: checkout-feature-tax"]
    AppB["App devserver B<br/>http://127.0.0.1:5174"]
    TemplateB["Browser template B<br/>targetUrl + profile/network/proxy"]
    SessionB["Transient session B<br/>cdpUrl → bkr_b"]
    ChromeB["Chrome instance B<br/>profile: checkout-feature-tax"]
  end

  Human -->|register apps/templates| Server
  Human -->|start template sessions| Server

  Server -->|persists| TemplateA
  TemplateA -. optional app link .-> AppA
  Server -->|start A| Broker
  Broker -->|owns bkr_a| ChromeA
  Broker -->|reports bkr_a| SessionA
  Server -->|proxies CDP| SessionA
  TemplateA -->|produces| SessionA
  ChromeA -->|loads| AppA

  Server -->|persists| TemplateB
  TemplateB -. optional app link .-> AppB
  Server -->|start B| Broker
  Broker -->|owns bkr_b| ChromeB
  Broker -->|reports bkr_b| SessionB
  Server -->|proxies CDP| SessionB
  TemplateB -->|produces| SessionB
  ChromeB -->|loads| AppB
```

Separate broker processes are still possible, but they are not the default.
They are only needed for broker-level isolation, different SSH tunnel settings,
or intentionally separate lifecycle boundaries.

## Contracts

The server should expose stable discovery endpoints:

```text
GET /_pwdev/manifest
GET /_pwdev/status
GET /_pwdev/instructions
GET /_pwdev/api
GET /_pwdev/env
GET /_pwdev/client.js
GET /_pwdev/proxies
POST /_pwdev/proxies
GET /_pwdev/proxies/:id
DELETE /_pwdev/proxies/:id
GET /_pwdev/proxies/:id/traffic
GET /_pwdev/networks
POST /_pwdev/networks
GET /_pwdev/networks/:id
DELETE /_pwdev/networks/:id
POST /_pwdev/networks/:id/check
GET /_pwdev/apps
POST /_pwdev/apps
GET /_pwdev/apps/:id
DELETE /_pwdev/apps/:id
GET /_pwdev/apps/:id/manifest
GET /_pwdev/browsers
POST /_pwdev/browsers
GET /_pwdev/browsers/:id
DELETE /_pwdev/browsers/:id
POST /_pwdev/browsers/:id/start
POST /_pwdev/browsers/:id/stop
GET /_pwdev/sessions
POST /_pwdev/sessions/:id/stop
ANY /_pwdev/broker/*
GET /_pwdev/proxy/status
GET /_pwdev/proxy/proxies
POST /_pwdev/proxy/proxies
GET /_pwdev/proxy/proxies/:id
DELETE /_pwdev/proxy/proxies/:id
POST /_pwdev/proxy/proxies/:id/stop
POST /_pwdev/proxy/stop-all
```

Apps are project metadata; browser templates own launch and target settings;
sessions are transient broker-backed runtime records. The app manifest remains
useful for app metadata, but it does not provide a live browser CDP URL:

```json
{
  "ok": true,
  "id": "checkout-feature-tax",
  "name": "Checkout tax branch",
  "worktree": "/home/me/work/app-tax",
  "branch": "feature/tax",
  "accounts": {
    "login": {
      "usr": "xxx",
      "pwd": "xxx"
    }
  },
  "readme": "Run npm run dev; compose proxy rules from proxy/rules.tpl"
}
```

The agent should use the API for discovery and its own Playwright client for
browser operations. Start a browser template and connect to the returned
session `cdpUrl`; it points at the pw-dev server's broker proxy:

```js
import { chromium } from 'playwright';

const started = await fetch(`${process.env.PW_DEV_URL}/_pwdev/browsers/checkout-feature-tax/start`, {
  method: 'POST',
})
  .then((response) => response.json());

const browser = await chromium.connectOverCDP(started.session.cdpUrl);
const context = browser.contexts()[0];
const page = context.pages()[0] ?? await context.newPage();

await page.goto(started.browser.targetUrl);
```

## Design Rules

- CLI starts and stops things for humans.
- API exposes structured discovery and control for agents.
- The server does not import Playwright by default.
- The server persists app, browser-template, network, and proxy metadata; it
  is not an app runner or proxy runner. Sessions are transient. Account
  metadata is for non-production test accounts only.
- `proxy` is the optional runner for managed Whistle proxies. It accepts
  external-agent rulesets, allocates separate proxy and GUI ports, registers
  the proxy, and can attach it to an app.
- The broker owns Chrome and persistent profile state.
- The agent attaches to the broker and does not close the browser unless asked.
- One broker process can own multiple Chrome instances/profiles.
- A browser template can start a default session or named parallel sessions;
  named sessions get isolated profiles by default.
