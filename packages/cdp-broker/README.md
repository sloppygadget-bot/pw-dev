# pw-cdp-broker

`pw-cdp-broker` launches a local visible Chrome/Chromium instance with a
persistent profile and exposes a Chrome-compatible DevTools Protocol endpoint.
Remote Playwright code can connect to that endpoint while you complete MFA in
the local browser window.

## Quick Start

Start the broker locally:

```bash
npm start -- --profile work-okta
```

Or run the CLI directly:

```bash
node bin/pw-cdp-broker.js --profile work-okta
```

From the remote code-server host, point Playwright at the broker endpoint:

```ts
const browser = await chromium.connectOverCDP('http://127.0.0.1:18080');
const context = browser.contexts()[0];
const page = context.pages()[0] ?? await context.newPage();
```

Or start the broker in standby mode and let remote Playwright choose the profile
and launch-time options:

```bash
node bin/pw-cdp-broker.js --standby
```

Then from the remote host:

```ts
const start = await fetch('http://127.0.0.1:18080/_broker/start', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    profile: 'work-okta',
    proxyServer: 'http://127.0.0.1:18899',
    ignoreSslErrors: true,
  }),
}).then((response) => response.json());

const browser = await chromium.connectOverCDP(start.cdpUrl);
```

A small helper keeps tests and agents from wiring the two calls differently:

```js
// client.js
import { chromium } from 'playwright';

export async function connectViaBroker({
  brokerUrl = 'http://127.0.0.1:18080',
  profile,
  proxyServer,
  proxyForwardId,
  proxyBypassList,
  ignoreSslErrors,
  headless,
} = {}) {
  const response = await fetch(`${brokerUrl}/_broker/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profile,
      proxyServer,
      proxyForwardId,
      proxyBypassList,
      ignoreSslErrors,
      headless,
    }),
  });

  if (!response.ok) {
    throw new Error(`Broker start failed: ${response.status} ${await response.text()}`);
  }

  const instance = await response.json();
  const browser = await chromium.connectOverCDP(instance.cdpUrl);

  return {
    browser,
    instance,
    stop: async () => {
      await fetch(`${brokerUrl}/_broker/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instanceId: instance.instanceId }),
      });
    },
  };
}
```

If the remote workspace cannot read this repository, fetch the same instructions
from the running broker:

```bash
curl http://127.0.0.1:18080/_broker/help
curl http://127.0.0.1:18080/_broker/client.js
```

`/_broker/instructions` remains available as a compatibility alias for
`/_broker/help`.

## SSH Reverse Tunnel

If the remote host cannot reach your laptop directly, create a reverse tunnel
from the local machine:

```bash
ssh -R 18080:localhost:18080 user@code-server
```

The broker can manage that tunnel and reuse OpenSSH authentication for 24 hours:

```bash
node bin/pw-cdp-broker.js --profile work-okta --ssh user@code-server
```

On first connect, the broker creates a detached OpenSSH control master:

```bash
ssh -o ControlMaster=yes \
  -o ControlPersist=24h \
  -o ControlPath="$HOME/.pw-cdp-broker/ssh/%C" \
  -N \
  -f \
  user@code-server
```

Then it requests the broker tunnel through that control master:

```bash
ssh -o ControlPath="$HOME/.pw-cdp-broker/ssh/%C" \
  -o ExitOnForwardFailure=yes \
  -O forward \
  -R 18080:localhost:18080 \
  user@code-server
```

The broker does not ask for, store, or cache SSH passwords. Any password,
passphrase, MFA, or host-key prompt comes from OpenSSH.

## Persistent Profiles

The default profile path is:

```text
~/.pw-cdp-broker/profiles/default
```

Named profiles map to:

```text
~/.pw-cdp-broker/profiles/<name>
```

Use separate profiles for separate applications or accounts:

```bash
node bin/pw-cdp-broker.js --profile work-okta
node bin/pw-cdp-broker.js --profile customer-a
```

## Proxy and TLS

Proxy and TLS-certificate behavior is configured when the broker launches the
local browser. A remote Playwright client connecting over CDP cannot apply those
launch-time options after the browser is already running.

```bash
node bin/pw-cdp-broker.js \
  --profile work-okta \
  --proxy-server http://127.0.0.1:8899 \
  --ignore-ssl-errors
```

If the proxy is running on the remote code-server host instead, let the broker
add an SSH local forward and point Chrome at that forwarded local port:

```bash
node bin/pw-cdp-broker.js \
  --profile work-okta \
  --ssh user@code-server \
  --ssh-proxy-remote-port 8899 \
  --ssh-proxy-local-port 18899 \
  --ignore-ssl-errors
```

That adds `ssh -L 18899:localhost:8899` alongside the broker's reverse tunnel,
and Chrome uses `http://127.0.0.1:18899` as its proxy unless
`--proxy-server` is set explicitly.

Remote Playwright code then connects normally:

```ts
const browser = await chromium.connectOverCDP('http://127.0.0.1:18080');
```

For advanced Chrome proxy syntax, pass raw flags with `--chrome-arg`.

When the proxy is on the remote SSH host and multiple broker-controlled
instances need to use it, create a managed proxy forward through the broker API:

```http
POST /_broker/proxy-forwards
Content-Type: application/json

{
  "name": "whistle",
  "remotePort": 8899,
  "localPort": 18899
}
```

The broker returns a reusable `proxyForwardId` and `proxyServer`:

```json
{
  "ok": true,
  "forwardId": "pf_...",
  "proxyServer": "http://127.0.0.1:18899"
}
```

Use `proxyForwardId` when starting instances. Multiple instances may share one
proxy forward:

```json
{
  "profile": "work-okta",
  "proxyForwardId": "pf_...",
  "ignoreSslErrors": true
}
```

## Remote Playwright Lifecycle

The broker owns the local browser process. Remote Playwright attaches to that
already-running browser with `connectOverCDP`; it does not launch the browser
directly.

In standby mode, remote code asks the broker to launch Chrome first:

```http
POST /_broker/start
Content-Type: application/json

{
  "profile": "work-okta",
  "proxyForwardId": "pf_...",
  "proxyBypassList": "<-loopback>",
  "ignoreSslErrors": true,
  "headless": false
}
```

The broker returns an instance-scoped CDP URL:

```json
{
  "ok": true,
  "instanceId": "bkr_...",
  "cdpUrl": "http://127.0.0.1:18080/_broker/instances/bkr_...",
  "profile": "work-okta"
}
```

Use that `cdpUrl` with `chromium.connectOverCDP(...)`. If Chrome is not running,
root CDP discovery such as `GET /json/version` returns `503` until
`/_broker/start` succeeds.

The broker can run multiple instances at once as long as they use different
profile directories. Two active Chrome processes cannot share the same
`--user-data-dir`; concurrent starts for the same profile are rejected with
`409`.

Clear a broker-managed persistent profile before starting a new instance:

```http
POST /_broker/profiles/clear
Content-Type: application/json

{
  "profile": "work-okta"
}
```

Only named broker profiles can be cleared through this API. The broker rejects
clearing a profile while a running instance is using it.

Root CDP paths are a compatibility shortcut for the single-instance case. When
multiple instances are running, remote clients should use the returned
instance-scoped `cdpUrl`.

At the end of a test, `await browser.close()` on a CDP-connected browser
disconnects that Playwright client and disposes its local `Browser` object. The
broker and local browser stay running, so the next test process can call
`connectOverCDP` again.

Remote Playwright can capture screenshots from the connected instance:

```ts
await page.screenshot({ path: 'after-test.png', fullPage: true });
```

Video recording for broker-controlled persistent sessions is intentionally out
of scope for now.

Roadmap: a later Playwright-backed launch mode could let the broker create the
persistent context with `recordVideo` enabled from the start, then expose
broker-side video artifacts for remote retrieval.

Stop the active browser instance:

```http
POST /_broker/stop
Content-Type: application/json

{
  "instanceId": "bkr_..."
}
```

Avoid sending raw CDP commands such as `Browser.close` from the remote side
unless you intentionally want to close the local browser. If the local browser
exits, the broker shuts down.

Reset a profile:

```bash
node bin/pw-cdp-broker.js --profile work-okta --reset-profile
```

## CDP Compatibility

The broker exposes Chrome-compatible discovery endpoints:

```text
GET /json/version
GET /json
GET /json/list
WS  /devtools/browser/<id>
WS  /devtools/page/<id>
```

It proxies those requests to the local Chrome remote debugging port and rewrites
`webSocketDebuggerUrl` values so Playwright connects back through the broker.

## CLI Options

```text
--port <port>                 Broker CDP port. Default: 18080
--host <host>                 Broker listen host. Default: 127.0.0.1
--profile <name>              Named broker profile. Default: default
--user-data-dir <path>        Explicit Chrome profile path; exclusive with --profile
--reset-profile               Delete the selected profile before launch
--chrome-port <port>          Chrome remote debugging port. Default: random free port
--chrome-executable <path>    Chrome/Chromium executable path
--chrome-arg <arg>            Extra Chrome arg; repeatable
--proxy-server <server>       Chrome proxy server, e.g. http://127.0.0.1:8899
--proxy-bypass-list <rules>   Chrome proxy bypass list
--ignore-ssl-errors           Ignore HTTPS certificate errors in Chrome
--quiet                       Suppress broker status logs and Chrome output
--standby                     Listen for broker control requests without launching Chrome
--headless                    Launch Chrome headless
--ssh <user@host>             Start an SSH reverse tunnel to a code-server host
--ssh-remote-port <port>      Remote tunnel port. Default: same as --port
--ssh-proxy-remote-port <p>   Forward remote proxy port to local Chrome
--ssh-proxy-local-port <p>    Local forwarded proxy port. Default: same as remote
--ssh-control-persist <time>  OpenSSH ControlPersist value. Default: 24h
```
