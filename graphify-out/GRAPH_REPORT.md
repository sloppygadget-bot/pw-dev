# Graph Report - pw-dev  (2026-08-07)

## Corpus Check
- 68 files · ~64,258 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 743 nodes · 1503 edges · 34 communities (33 shown, 1 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 22 edges (avg confidence: 0.65)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `2ee954d8`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- app.js
- cdp-broker/src/cli.js
- server/src/index.js
- gui/src/server.js
- scripts
- cdp-broker/src/server.js
- proxy/src/index.js
- pw-dev Server
- throwValidationError
- networks.js
- proxy-forwards.js
- handleBrowsersRequest
- handlePwDevRequest
- check-kb.mjs
- cdp-broker/package.json
- proxy/package.json
- gui/package.json
- server/package.json
- cli/package.json
- server/test/server.test.js
- server/src/cli.js
- httpError
- proxy.test.js
- recoverProxyProfiles
- proxy/src/cli.js
- handleProxiesRequest
- handleProxyManagerRequest
- handleApiRequest
- CDP Broker API
- System model
- pw-dev
- AGENTS.md
- pw-dev.e2e.test.js
- Q: Why does startPwDevServer() connect Server Registry to OpenAPI Catalog, File and JSON Utilities, HTTP Test Helpers, Proxy Manager, and Proxy Broker Bridge

## God Nodes (most connected - your core abstractions)
1. `startPwDevServer()` - 30 edges
2. `throwValidationError()` - 27 edges
3. `handlePwDevRequest()` - 24 edges
4. `handleBrowsersRequest()` - 20 edges
5. `main()` - 19 edges
6. `requiredString()` - 19 edges
7. `omitUndefined()` - 18 edges
8. `writeJson()` - 16 edges
9. `scripts` - 15 edges
10. `optionalString()` - 15 edges

## Surprising Connections (you probably didn't know these)
- `Durable Proxy Profiles` --semantically_similar_to--> `Durable Profile Lifecycle Principle`  [INFERRED] [semantically similar]
  docs/server.md → packages/proxy/openapi/lifecycle.json
- `pw-dev Example Page` --semantically_similar_to--> `pw-dev Server`  [INFERRED] [semantically similar]
  examples/static-site/index.html → docs/server.md
- `Agent Workflow Instructions` --semantically_similar_to--> `Agent Discovery Workflow`  [INFERRED] [semantically similar]
  packages/server/instructions/agent.md → docs/server.md
- `App API` --conceptually_related_to--> `Agent Discovery Workflow`  [INFERRED]
  packages/server/openapi/apps.json → docs/server.md
- `Proxy Traffic API` --conceptually_related_to--> `Exclusive Proxy Leases`  [INFERRED]
  packages/server/openapi/proxies/traffic.json → docs/server.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **pw-dev Control Plane Components** — docs_server_pwdev_server, packages_cdp_broker_openapi_root_broker_api, packages_proxy_openapi_root_managed_proxy_api, packages_server_openapi_root_control_plane_api [INFERRED 0.85]
- **Browser Proxy Traffic Flow** — packages_server_openapi_browsers_browser_template_api, packages_server_openapi_sessions_session_api, packages_server_openapi_proxies_traffic_proxy_traffic_api [INFERRED 0.85]
- **Progressive API Discovery** — packages_server_openapi_root_control_plane_api, packages_server_openapi_apps_app_api, packages_server_openapi_browsers_browser_template_api [EXTRACTED 1.00]

## Communities (34 total, 1 thin omitted)

### Community 0 - "app.js"
Cohesion: 0.06
Nodes (78): actionGroup(), appLink(), badge(), brokerLabel(), browserActions(), browserConfigActions(), browserConfigUsage(), closeBrowserConfigEditor() (+70 more)

### Community 1 - "cdp-broker/src/cli.js"
Cohesion: 0.08
Nodes (39): booleanOption(), BrowserManager, createBrowserManager(), describeInstance(), makeInstanceId(), mergeExtraArgs(), optionOrDefault(), brokerHome() (+31 more)

### Community 2 - "server/src/index.js"
Cohesion: 0.08
Nodes (45): BROKER_PACKAGE_ROOT, cloneApp(), cloneBrowserSessions(), composeBrowserSessionId(), composeDefaultBrowserSessionId(), createAppRegistry(), createBrokerPairing(), createBrowserConfigRegistry() (+37 more)

### Community 3 - "gui/src/server.js"
Cohesion: 0.09
Nodes (37): helpText(), main(), helpText(), main(), parseArgs(), parsePort(), readValue(), collectBrokerSnapshot() (+29 more)

### Community 4 - "scripts"
Cohesion: 0.06
Nodes (34): bin, pw-dev, dependencies, swagger-ui-dist, description, devDependencies, playwright, @playwright/cli (+26 more)

### Community 5 - "cdp-broker/src/server.js"
Cohesion: 0.13
Nodes (27): BROKER_PACKAGE_ROOT, brokerClientSource(), brokerInstructions(), buildUpgradeRequest(), createBrokerServer(), handleControlRequest(), instanceBaseUrl(), joinUrlPath() (+19 more)

### Community 6 - "proxy/src/index.js"
Cohesion: 0.10
Nodes (18): applyWhistleProjectRules(), cleanupManagedProxy(), cleanupProcessRecord(), createManagedRuleState(), createProxyStorageDir(), DEFAULT_W2_STORAGE_ROOT, delay(), ensureTrailingSlash() (+10 more)

### Community 7 - "pw-dev Server"
Cohesion: 0.09
Nodes (27): Agent Discovery Workflow, Broker-Backed Browser Sessions, Durable Proxy Profiles, Exclusive Proxy Leases, pw-dev Server, pw-dev Example Page, Chrome DevTools Protocol Endpoint, Persistent Browser Profile (+19 more)

### Community 8 - "throwValidationError"
Cohesion: 0.19
Nodes (28): browserProfile(), loadPersistedBrowserConfigs(), optionalPath(), optionalString(), requiredOneOf(), requiredPositiveInteger(), requiredString(), requiredStringAllowEmpty() (+20 more)

### Community 9 - "networks.js"
Cohesion: 0.22
Nodes (16): describeNetwork(), inUseBy(), NetworkManager, normalizePort(), normalizeProxyServer(), omitUndefined(), optionalString(), optionalStringArray() (+8 more)

### Community 10 - "proxy-forwards.js"
Cohesion: 0.17
Nodes (10): buildProxySshArgs(), describeForward(), inUseBy(), makeForwardId(), normalizePort(), normalizeProbeHost(), normalizeProbePort(), normalizeProbeTimeout() (+2 more)

### Community 11 - "handleBrowsersRequest"
Cohesion: 0.14
Nodes (28): brokerJson(), buildAppResponse(), buildBrowserResponse(), chooseBrowserProxy(), createSessionLease(), ensureManagedProxyRunning(), findActiveBrowserProfile(), findBrowserSessionConflict() (+20 more)

### Community 12 - "handlePwDevRequest"
Cohesion: 0.12
Nodes (26): brokerDelegateInstructions(), browserConfigOccupants(), browserConfigReferences(), buildManifest(), controlPlaneOpenApiCatalog(), handleBrokerDelegateOpenApiRequest(), handleBrowserConfigsRequest(), handleOpenApiRequest() (+18 more)

### Community 13 - "check-kb.mjs"
Cohesion: 0.19
Nodes (21): errors, files, HTTP_METHODS, markdownCount, openApiCount, openApiOperations(), readJson(), relative() (+13 more)

### Community 14 - "cdp-broker/package.json"
Cohesion: 0.10
Nodes (20): bin, pw-cdp-broker, description, engines, node, exports, ./browser-manager, ./chrome (+12 more)

### Community 15 - "proxy/package.json"
Cohesion: 0.11
Nodes (18): bin, pw-dev-proxy, dependencies, whistle, description, engines, node, exports (+10 more)

### Community 16 - "gui/package.json"
Cohesion: 0.12
Nodes (15): bin, pw-dev-gui, description, engines, node, exports, ./cli, license (+7 more)

### Community 17 - "server/package.json"
Cohesion: 0.12
Nodes (15): bin, pw-dev-server, description, engines, node, exports, ./cli, license (+7 more)

### Community 18 - "cli/package.json"
Cohesion: 0.13
Nodes (14): bin, pw-dev, description, engines, node, exports, license, name (+6 more)

### Community 19 - "server/test/server.test.js"
Cohesion: 0.22
Nodes (11): deleteJson(), get(), getJson(), patchJson(), postJson(), readRequestJson(), requestJson(), startMockBroker() (+3 more)

### Community 20 - "server/src/cli.js"
Cohesion: 0.30
Nodes (10): createProxyManager(), createPwDevRegistryClient(), normalizeHttpUrl(), resolveWhistleLauncher(), startProxyManagerServer(), helpText(), main(), parseArgs() (+2 more)

### Community 21 - "httpError"
Cohesion: 0.23
Nodes (12): getRunningProxy(), httpError(), optionalString(), parsePort(), parsePortRange(), requestJson(), selectPort(), spawnManagedProcess() (+4 more)

### Community 22 - "proxy.test.js"
Cohesion: 0.25
Nodes (6): deleteJson(), get(), getJson(), postJson(), putJson(), requestJson()

### Community 23 - "recoverProxyProfiles"
Cohesion: 0.25
Nodes (9): cleanupOrphanedProxies(), extractManagedStorageDir(), isWithinRoot(), listProcessRecords(), omitUndefined(), recoverProxyProfiles(), removeStaleRegistryRecord(), stripChild() (+1 more)

### Community 24 - "proxy/src/cli.js"
Cohesion: 0.52
Nodes (5): helpText(), main(), parseArgs(), parsePort(), readValue()

### Community 25 - "handleProxiesRequest"
Cohesion: 0.22
Nodes (10): buildUpgradeRequest(), ensureTrailingSlash(), getWhistleTraffic(), handleProxiesRequest(), proxyBrokerHttpRequest(), proxyBrokerPath(), proxyBrokerUpgrade(), proxyOccupants() (+2 more)

### Community 26 - "handleProxyManagerRequest"
Cohesion: 0.50
Nodes (5): createProxyManagerHttpServer(), handleProxyManagerRequest(), readJsonBody(), writeJson(), writeMethodNotAllowed()

### Community 27 - "handleApiRequest"
Cohesion: 0.67
Nodes (4): findApiOperation(), handleApiRequest(), pwDevApi(), pwDevApiDetails()

### Community 29 - "System model"
Cohesion: 0.07
Nodes (22): Agent lease is separate from Chrome, Browser lifecycle, One browser, one live session, Proxy pool behavior, Stable profile and cleanup, Three layers, three owners, E2E test design, 1. Verify an app change in a persistent browser (+14 more)

### Community 30 - "pw-dev"
Cohesion: 0.13
Nodes (13): Components, Contracts, Design Rules, Multi-App Flow, pw-dev Architecture, Runtime Flow, Implementation Standard, Install (+5 more)

### Community 31 - "AGENTS.md"
Cohesion: 0.22
Nodes (7): Basic Agent Usage, Install, Project Overview, References, Server lifecycle, Start The Broker, Start The Server

### Community 32 - "pw-dev.e2e.test.js"
Cohesion: 0.46
Nodes (6): makeServer(), readBody(), send(), startBrokerDouble(), startDouble(), startProxyDouble()

### Community 33 - "Q: Why does startPwDevServer() connect Server Registry to OpenAPI Catalog, File and JSON Utilities, HTTP Test Helpers, Proxy Manager, and Proxy Broker Bridge"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: Why does startPwDevServer() connect Server Registry to OpenAPI Catalog, File and JSON Utilities, HTTP Test Helpers, Proxy Manager, and Proxy Broker Bridge, Source Nodes

## Knowledge Gaps
- **157 isolated node(s):** `name`, `version`, `private`, `type`, `description` (+152 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `startPwDevServer()` connect `server/src/index.js` to `pw-dev.e2e.test.js`, `throwValidationError`, `handlePwDevRequest`, `check-kb.mjs`, `server/test/server.test.js`, `server/src/cli.js`, `handleProxiesRequest`?**
  _High betweenness centrality (0.037) - this node is a cross-community bridge._
- **Why does `main()` connect `cdp-broker/src/cli.js` to `gui/src/server.js`, `cdp-broker/src/server.js`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **Why does `main()` connect `server/src/cli.js` to `server/src/index.js`, `gui/src/server.js`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _157 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `app.js` be split into smaller, more focused modules?**
  _Cohesion score 0.06487341772151899 - nodes in this community are weakly interconnected._
- **Should `cdp-broker/src/cli.js` be split into smaller, more focused modules?**
  _Cohesion score 0.07978142076502732 - nodes in this community are weakly interconnected._
- **Should `server/src/index.js` be split into smaller, more focused modules?**
  _Cohesion score 0.07712765957446809 - nodes in this community are weakly interconnected._