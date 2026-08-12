# @pw-dev/proxy

`@pw-dev/proxy` manages the repository's in-house Whistle profiles. Each
managed proxy has an isolated Whistle `-S` directory under
`packages/proxy/.runtime/whistle` by default.

## Lifecycle contract

The `pw-dev-proxy.json` record inside the Whistle profile is the durable source
of truth. The pw-dev server proxy registry mirrors it for discovery; it does not
own managed proxy configuration.

- Create allocates ports and writes the profile and rules without starting Whistle.
- Starting a browser launches its managed Whistle proxy on demand; stopping the last browser session stops Whistle while preserving the profile.
- Start is idempotent and reuses the saved profile, ports, and rules.
- Stop preserves the profile, rules, ports, and captured traffic.
- Process failure marks the profile stopped; it does not delete it.
- Manager shutdown stops processes and preserves profiles.
- Delete is the only operation that removes a managed profile.

Profiles can exist without an app association. This makes them reusable across
apps, browser configs, tests, and tasks.

## Start

The server normally starts this manager lazily and republishes its API under
`/_pwdev/proxy/*`. To run it separately:

```bash
npm start -- proxy
```

Use the pw-dev server origin from agents. Do not call the internal manager port
directly.

## Reusable browser pools

Create several durable proxies, then put their ids in a browser config's
`proxyIds` field. Each durable browser reserves one proxy exclusively.
Stopping the browser session preserves the reservation and stops Whistle when
no other live session uses it. The next browser start launches it again.

The session's `proxyLease.trafficStartTime` is a Whistle traffic cursor. Pass it
as `startTime` to `GET /_pwdev/proxies/:id/traffic` to exclude traffic captured
before the current lease.

Proxy leases are transient session state. Stop active browser sessions before
restarting the pw-dev server so their leases are released explicitly.

## Rules

Managed rules are durable profile state. Replace them atomically with:

```text
PUT /_pwdev/proxy/proxies/:id/rules
```

Send the complete `defaultRuleset` and `overrideRuleset` plus the current
`baseVersion`. A stale version returns a conflict instead of overwriting a
concurrent update.

## Contracts and tests

- OpenAPI: `packages/proxy/openapi/`
- Runtime implementation: `packages/proxy/src/index.js`
- Lifecycle tests: `packages/proxy/test/proxy.test.js`

Run:

```bash
npm run test:proxy
npm run check:kb
```
