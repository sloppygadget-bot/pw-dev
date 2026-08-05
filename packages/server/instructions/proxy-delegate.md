# pw-dev proxy delegate

This API is owned by the proxy manager but is delivered through pw-dev. Use
only `{{SERVER_URL}}/_pwdev/proxy/*`; do not call the proxy-manager port
directly.

Fetch `{{SERVER_URL}}/_pwdev/delegates/proxy/openapi.json` first. Then load only
the linked lifecycle or ruleset document needed for the next operation. Use the
control-plane `/_pwdev/openapi/proxies.json` document to register proxy metadata
or read captured traffic for a registered proxy.

The in-house Whistle `-S` profile is the durable source of truth. Start, stop,
restart, manager shutdown, and browser lease release preserve it. Only the
managed-proxy `DELETE` operation removes the profile and its retained state.
