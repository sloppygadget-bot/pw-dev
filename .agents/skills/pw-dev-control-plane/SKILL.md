---
name: pw-dev-control-plane
description: Translate human requests into verified pw-dev API or CLI operations. Use for any request to inspect, start, stop, create, update, attach to, or remove pw-dev apps, browser configs, browsers, sessions, proxies, remote brokers, or GUI/server processes.
---

# pw-dev Intent Translator

Convert the user's requested outcome into the smallest correct pw-dev operation.
Use the server API for managed state; use the `pw-dev` CLI only to start or
stop top-level local services.

## Resolve the live contract

Before choosing an operation, discover the running server. Its instructions
and OpenAPI documents override any remembered route or payload shape.

```bash
export PW_DEV_URL="${PW_DEV_URL:-http://127.0.0.1:9696}"
curl -fsS "$PW_DEV_URL/_pwdev/status"
curl -fsS "$PW_DEV_URL/_pwdev/instructions"
curl -fsS "$PW_DEV_URL/_pwdev/openapi.json"
```

Confirm `status.root` or `status.worktree` is the intended checkout whenever
more than one pw-dev server could be running. Use only
`$PW_DEV_URL/_pwdev/*`; never operate internal broker or proxy-manager ports
directly. Load the linked OpenAPI document for the requested resource before a
state-changing call.

## Translate the request

1. Identify the verb: inspect, create, start, attach, stop, delete, or update.
2. Identify the durable resource and its ID: app, browser config, browser,
   managed proxy, or remote broker; identify a session only for live browser
   work.
3. Before creating a browser, resolve its pairing. If the request does not
   explicitly say standalone or name an app and/or proxy, ask whether to pair
   the browser with an app, a proxy, both, or neither. Do not create the
   browser or its config until the user answers.
4. Resolve dependencies only when needed. A browser needs a browser config;
   an optional proxy must exist before a browser can reference it.
5. Execute the minimal matching API call or top-level CLI command.
6. Fetch the affected resource or collection and report the resulting state.

Interpret common shorthand naturally:

- “browser named crawler” → browser ID/name `crawler`.
- “create crawler” with no pairing choice → ask: “Should `crawler` be
  standalone, or should I pair it with an app, a proxy, or both?”
- “empty ruleset proxy” → managed proxy creation with an explicit empty
  `ruleset` value, not an omitted ruleset.
- “clear browsers” → list sessions, stop applicable sessions, then delete the
  requested browser records; do not delete their configs or proxies unless the
  request says to clear those too.
- “kill server/GUI” → identify the exact top-level pw-dev process tree first,
  then stop it gracefully and verify the port/process is gone.

## Respect state boundaries

Read-only requests may inspect status, logs, collections, and live API
documents. For destructive requests, resolve and list exact targets before
deleting them. Stop occupied sessions before deleting their browser or proxy.
Do not modify resources belonging to another agent unless the user explicitly
includes them in scope.

Use `/_pwdev/delegates` before managed-proxy lifecycle/ruleset operations and
before advanced broker operations; follow the linked component OpenAPI.
Use `/_pwdev/remote-brokers` for remote broker operations. For server-owned SSH
credentials, manage `/_pwdev/ssh-keys` and `/_pwdev/remote-hosts` first. Never
read a private key back: imports are write-only, reads expose redacted metadata.
Prefer `hostId` when provisioning a remote broker. `remotePort` is on the
remote host; `localPort` is the server loopback forward (for example,
`18081 -> remote 18080`). After key rotation, re-provision or reconnect the
broker so a new SSH control master uses the replacement key.

## Report succinctly

Lead with the completed outcome. State the resource IDs, lifecycle state, and
any preserved or removed dependent resources. If an operation cannot safely be
inferred from the request, state the exact missing choice instead of guessing.
