# Graph Report - .  (2026-08-01)

## Corpus Check
- 60 files · ~53,926 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 660 nodes · 1357 edges · 29 communities (28 shown, 1 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 18 edges (avg confidence: 0.68)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- GUI Visualization
- CDP Broker Runtime
- Server Registry
- CLI Argument Handling
- Package Metadata
- Server Control Plane
- Proxy Lifecycle
- Agent and API Concepts
- Validation Helpers
- Network Management
- Proxy Forwarding
- Browser and App Routes
- OpenAPI Catalog
- File and JSON Utilities
- Broker Package
- Proxy Package
- GUI Package
- Server Package
- Root Package
- HTTP Test Helpers
- Proxy Manager
- Proxy Process Control
- Proxy HTTP Client
- Proxy Recovery
- Proxy CLI
- Proxy Broker Bridge
- Proxy Manager HTTP API
- API Request Routing
- Thin Community

## God Nodes (most connected - your core abstractions)
1. `startPwDevServer()` - 25 edges
2. `throwValidationError()` - 24 edges
3. `handlePwDevRequest()` - 23 edges
4. `main()` - 19 edges
5. `handleBrowserTemplatesRequest()` - 17 edges
6. `requiredString()` - 17 edges
7. `writeJson()` - 15 edges
8. `omitUndefined()` - 15 edges
9. `scripts` - 14 edges
10. `render()` - 14 edges

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

## Communities (29 total, 1 thin omitted)

### Community 0 - "GUI Visualization"
Cohesion: 0.06
Nodes (76): appLink(), badge(), badgeElement(), brokerLabel(), buildD3LayoutIndex(), buildMermaidDiagram(), buildSnapshotMarkdown(), buildTopologyContexts() (+68 more)

### Community 1 - "CDP Broker Runtime"
Cohesion: 0.08
Nodes (39): booleanOption(), BrowserManager, createBrowserManager(), describeInstance(), makeInstanceId(), mergeExtraArgs(), optionOrDefault(), brokerHome() (+31 more)

### Community 2 - "Server Registry"
Cohesion: 0.08
Nodes (44): BROKER_PACKAGE_ROOT, buildManifest(), cloneApp(), cloneBrowserSessions(), composeBrowserSessionId(), composeDefaultBrowserSessionId(), createAppRegistry(), createBrokerPairing() (+36 more)

### Community 3 - "CLI Argument Handling"
Cohesion: 0.09
Nodes (37): helpText(), main(), helpText(), main(), parseArgs(), parsePort(), readValue(), collectBrokerSnapshot() (+29 more)

### Community 4 - "Package Metadata"
Cohesion: 0.06
Nodes (33): bin, pw-dev, dependencies, swagger-ui-dist, description, devDependencies, playwright, @playwright/cli (+25 more)

### Community 5 - "Server Control Plane"
Cohesion: 0.13
Nodes (27): BROKER_PACKAGE_ROOT, brokerClientSource(), brokerInstructions(), buildUpgradeRequest(), createBrokerServer(), handleControlRequest(), instanceBaseUrl(), joinUrlPath() (+19 more)

### Community 6 - "Proxy Lifecycle"
Cohesion: 0.10
Nodes (18): applyWhistleProjectRules(), cleanupManagedProxy(), cleanupProcessRecord(), createManagedRuleState(), createProxyStorageDir(), DEFAULT_W2_STORAGE_ROOT, delay(), ensureTrailingSlash() (+10 more)

### Community 7 - "Agent and API Concepts"
Cohesion: 0.09
Nodes (27): Agent Discovery Workflow, Broker-Backed Browser Sessions, Durable Proxy Profiles, Exclusive Proxy Leases, pw-dev Server, pw-dev Example Page, Chrome DevTools Protocol Endpoint, Persistent Browser Profile (+19 more)

### Community 8 - "Validation Helpers"
Cohesion: 0.23
Nodes (25): omitUndefined(), optionalPath(), optionalString(), requiredOneOf(), requiredPositiveInteger(), requiredString(), requiredStringAllowEmpty(), resolveBrowserStopTarget() (+17 more)

### Community 9 - "Network Management"
Cohesion: 0.22
Nodes (16): describeNetwork(), inUseBy(), NetworkManager, normalizePort(), normalizeProxyServer(), omitUndefined(), optionalString(), optionalStringArray() (+8 more)

### Community 10 - "Proxy Forwarding"
Cohesion: 0.17
Nodes (10): buildProxySshArgs(), describeForward(), inUseBy(), makeForwardId(), normalizePort(), normalizeProbeHost(), normalizeProbePort(), normalizeProbeTimeout() (+2 more)

### Community 11 - "Browser and App Routes"
Cohesion: 0.15
Nodes (23): brokerJson(), buildAppResponse(), buildProxyPoolState(), ensureManagedProxyRunning(), findActiveBrowserProfile(), findBrowserSessionConflict(), handleAppBrowserRequest(), handleAppsRequest() (+15 more)

### Community 12 - "OpenAPI Catalog"
Cohesion: 0.14
Nodes (22): brokerDelegateInstructions(), controlPlaneOpenApiCatalog(), handleBrokerDelegateOpenApiRequest(), handleOpenApiRequest(), handleProxyDelegateOpenApiRequest(), handlePwDevRequest(), OPENAPI_HTTP_METHODS, PROXY_OPENAPI_DOCUMENTS (+14 more)

### Community 13 - "File and JSON Utilities"
Cohesion: 0.19
Nodes (21): errors, files, HTTP_METHODS, markdownCount, openApiCount, openApiOperations(), readJson(), relative() (+13 more)

### Community 14 - "Broker Package"
Cohesion: 0.10
Nodes (20): bin, pw-cdp-broker, description, engines, node, exports, ./browser-manager, ./chrome (+12 more)

### Community 15 - "Proxy Package"
Cohesion: 0.11
Nodes (18): bin, pw-dev-proxy, dependencies, whistle, description, engines, node, exports (+10 more)

### Community 16 - "GUI Package"
Cohesion: 0.12
Nodes (15): bin, pw-dev-gui, description, engines, node, exports, ./cli, license (+7 more)

### Community 17 - "Server Package"
Cohesion: 0.12
Nodes (15): bin, pw-dev-server, description, engines, node, exports, ./cli, license (+7 more)

### Community 18 - "Root Package"
Cohesion: 0.13
Nodes (14): bin, pw-dev, description, engines, node, exports, license, name (+6 more)

### Community 19 - "HTTP Test Helpers"
Cohesion: 0.22
Nodes (11): deleteJson(), get(), getJson(), patchJson(), postJson(), readRequestJson(), requestJson(), startMockBroker() (+3 more)

### Community 20 - "Proxy Manager"
Cohesion: 0.30
Nodes (10): createProxyManager(), createPwDevRegistryClient(), normalizeHttpUrl(), resolveWhistleLauncher(), startProxyManagerServer(), helpText(), main(), parseArgs() (+2 more)

### Community 21 - "Proxy Process Control"
Cohesion: 0.23
Nodes (12): getRunningProxy(), httpError(), optionalString(), parsePort(), parsePortRange(), requestJson(), selectPort(), spawnManagedProcess() (+4 more)

### Community 22 - "Proxy HTTP Client"
Cohesion: 0.25
Nodes (6): deleteJson(), get(), getJson(), postJson(), putJson(), requestJson()

### Community 23 - "Proxy Recovery"
Cohesion: 0.25
Nodes (9): cleanupOrphanedProxies(), extractManagedStorageDir(), isWithinRoot(), listProcessRecords(), omitUndefined(), recoverProxyProfiles(), removeStaleRegistryRecord(), stripChild() (+1 more)

### Community 24 - "Proxy CLI"
Cohesion: 0.52
Nodes (5): helpText(), main(), parseArgs(), parsePort(), readValue()

### Community 25 - "Proxy Broker Bridge"
Cohesion: 0.33
Nodes (7): buildUpgradeRequest(), ensureTrailingSlash(), getWhistleTraffic(), proxyBrokerHttpRequest(), proxyBrokerPath(), proxyBrokerUpgrade(), writeBrokerError()

### Community 26 - "Proxy Manager HTTP API"
Cohesion: 0.50
Nodes (5): createProxyManagerHttpServer(), handleProxyManagerRequest(), readJsonBody(), writeJson(), writeMethodNotAllowed()

### Community 27 - "API Request Routing"
Cohesion: 0.67
Nodes (4): findApiOperation(), handleApiRequest(), pwDevApi(), pwDevApiDetails()

## Knowledge Gaps
- **118 isolated node(s):** `name`, `version`, `private`, `type`, `description` (+113 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `startPwDevServer()` connect `Server Registry` to `OpenAPI Catalog`, `File and JSON Utilities`, `HTTP Test Helpers`, `Proxy Manager`, `Proxy Broker Bridge`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **Why does `main()` connect `CDP Broker Runtime` to `CLI Argument Handling`, `Server Control Plane`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Why does `main()` connect `Proxy Manager` to `Server Registry`, `CLI Argument Handling`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _118 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `GUI Visualization` be split into smaller, more focused modules?**
  _Cohesion score 0.060939060939060936 - nodes in this community are weakly interconnected._
- **Should `CDP Broker Runtime` be split into smaller, more focused modules?**
  _Cohesion score 0.07978142076502732 - nodes in this community are weakly interconnected._
- **Should `Server Registry` be split into smaller, more focused modules?**
  _Cohesion score 0.07770582793709528 - nodes in this community are weakly interconnected._