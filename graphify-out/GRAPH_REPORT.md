# Graph Report - .  (2026-08-09)

## Corpus Check
- 8 files · ~73,797 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 872 nodes · 1742 edges · 48 communities (45 shown, 3 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 26 edges (avg confidence: 0.66)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Dashboard Client
- CLI Dispatcher
- CDP Broker Lifecycle
- Server Registry State
- DOM Monitor
- Root Package
- Browser API
- Remote Broker SSH
- Broker Server
- Validation Utilities
- Proxy Manager
- Network Management
- Proxy Forwarding
- Server CLI
- Knowledge Base Validation
- CDP Broker Package
- API Catalog
- Proxy Package
- GUI Package
- Server Package
- CLI Package
- Proxy CLI
- Proxy Runtime
- Proxy Tests
- Broker Proxy Delegation
- Project Documentation
- Browser Lifecycle Docs
- API Documentation
- Proxy Process Cleanup
- E2E Tests
- Browser Session Lease
- Agent Guide
- Test Documentation
- Server Architecture
- Architecture Components
- User Journeys
- Knowledge Base Workflows
- Query History
- Proxy Pool
- GUI Monitor
- Proxy Lifecycle
- Proxy HTTP Server
- API Router
- Server Documentation
- CDP Concepts
- Broker API
- Static Example
- Restart Persistence

## God Nodes (most connected - your core abstractions)
1. `startPwDevServer()` - 31 edges
2. `throwValidationError()` - 27 edges
3. `handlePwDevRequest()` - 25 edges
4. `startPwDevGuiServer()` - 20 edges
5. `handleBrowsersRequest()` - 20 edges
6. `main()` - 19 edges
7. `requiredString()` - 19 edges
8. `omitUndefined()` - 18 edges
9. `writeJson()` - 17 edges
10. `scripts` - 15 edges

## Surprising Connections (you probably didn't know these)
- `Server Registry Construction Hub` --semantically_similar_to--> `Control plane`  [INFERRED] [semantically similar]
  graphify-out/memory/query_20260802_070533_why_does_startpwdevserver___connect_server_registr.md → .kn/system.md
- `Control plane` --semantically_similar_to--> `Persisted Control Plane Architecture`  [INFERRED] [semantically similar]
  .kn/system.md → docs/architecture.md
- `App Attach Contract` --semantically_similar_to--> `CDP Attach Workflow`  [INFERRED] [semantically similar]
  .kn/system.md → packages/server/instructions/agent.md
- `API Documentation` --references--> `pw-dev Control-Plane API`  [INFERRED]
  packages/gui/public/api-docs.html → packages/server/openapi/root.json
- `validateLiveKnowledge()` --calls--> `startPwDevServer()`  [EXTRACTED]
  scripts/check-kb.mjs → packages/server/src/index.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **pw-dev Control Plane Flow** — docs_architecture_control_plane, kn_system_control_plane, packages_server_instructions_agent_server_origin, graphify_out_memory_query_server_registry_hub [INFERRED 0.95]
- **Browser Configuration to Session Lifecycle** — kn_system_browser_session_model, docs_architecture_runtime_flow, packages_server_instructions_agent_cdp_attach, kn_journeys_app_verification [EXTRACTED 1.00]
- **Reusable Proxy Pool Pattern** — kn_browser_lifecycle_proxy_pool, kn_system_proxy_pool_lease, kn_journeys_proxy_isolation, packages_proxy_readme_durable_whistle_profile [EXTRACTED 1.00]
- **Browser Proxy Traffic Flow** — packages_server_openapi_browsers_browser_template_api, packages_server_openapi_sessions_session_api, packages_server_openapi_proxies_traffic_proxy_traffic_api [INFERRED 0.85]
- **Progressive API Discovery** — packages_server_openapi_root_control_plane_api, packages_server_openapi_apps_app_api, packages_server_openapi_browsers_browser_template_api [EXTRACTED 1.00]

## Communities (48 total, 3 thin omitted)

### Community 0 - "Dashboard Client"
Cohesion: 0.06
Nodes (88): actionGroup(), appendInlineMarkdown(), appLink(), badge(), brokerLabel(), browserActions(), browserConfigActions(), browserConfigLink() (+80 more)

### Community 1 - "CLI Dispatcher"
Cohesion: 0.07
Nodes (47): helpText(), main(), helpText(), main(), parseArgs(), parsePort(), readValue(), ALLOWED_ACTIONS (+39 more)

### Community 2 - "CDP Broker Lifecycle"
Cohesion: 0.08
Nodes (37): booleanOption(), BrowserManager, createBrowserManager(), describeInstance(), makeInstanceId(), mergeExtraArgs(), optionOrDefault(), brokerHome() (+29 more)

### Community 3 - "Server Registry State"
Cohesion: 0.07
Nodes (49): BROKER_PACKAGE_ROOT, browserConfigOccupants(), browserConfigReferences(), cloneApp(), cloneBrowserSessions(), composeBrowserSessionId(), composeDefaultBrowserSessionId(), createAppRegistry() (+41 more)

### Community 4 - "DOM Monitor"
Cohesion: 0.08
Nodes (40): activity, addActivity(), annotatePaths(), applyPatch(), attachFrameEvents(), browserId, clickMarker, closeSidebar (+32 more)

### Community 5 - "Root Package"
Cohesion: 0.06
Nodes (34): bin, pw-dev, dependencies, swagger-ui-dist, description, devDependencies, playwright, @playwright/cli (+26 more)

### Community 6 - "Browser API"
Cohesion: 0.11
Nodes (33): brokerJson(), browserProfile(), buildAppResponse(), buildBrowserResponse(), chooseBrowserProxy(), createSessionLease(), ensureManagedProxyRunning(), findActiveBrowserProfile() (+25 more)

### Community 7 - "Remote Broker SSH"
Cohesion: 0.13
Nodes (26): buildSshLocalForwardArgs(), buildSshLocalForwardCancelArgs(), buildSshRemoteBrokerBootstrapArgs(), buildSshRemoteBrokerStopArgs(), cancelSshLocalForward(), canListen(), createRemoteBrokerManager(), delay() (+18 more)

### Community 8 - "Broker Server"
Cohesion: 0.13
Nodes (27): BROKER_PACKAGE_ROOT, brokerClientSource(), brokerInstructions(), buildUpgradeRequest(), createBrokerServer(), handleControlRequest(), instanceBaseUrl(), joinUrlPath() (+19 more)

### Community 9 - "Validation Utilities"
Cohesion: 0.21
Nodes (29): omitUndefined(), optionalPath(), optionalString(), requiredOneOf(), requiredPositiveInteger(), requiredString(), requiredStringAllowEmpty(), resolveBrowserStopTarget() (+21 more)

### Community 10 - "Proxy Manager"
Cohesion: 0.10
Nodes (18): applyWhistleProjectRules(), cleanupManagedProxy(), cleanupProcessRecord(), createManagedRuleState(), createProxyStorageDir(), DEFAULT_W2_STORAGE_ROOT, delay(), ensureTrailingSlash() (+10 more)

### Community 11 - "Network Management"
Cohesion: 0.21
Nodes (17): createNetworkManager(), describeNetwork(), inUseBy(), NetworkManager, normalizePort(), normalizeProxyServer(), omitUndefined(), optionalString() (+9 more)

### Community 12 - "Proxy Forwarding"
Cohesion: 0.16
Nodes (11): buildProxySshArgs(), createProxyForwardManager(), describeForward(), inUseBy(), makeForwardId(), normalizePort(), normalizeProbeHost(), normalizeProbePort() (+3 more)

### Community 13 - "Server CLI"
Cohesion: 0.16
Nodes (16): helpText(), main(), parseArgs(), parsePort(), readValue(), deleteJson(), get(), getJson() (+8 more)

### Community 14 - "Knowledge Base Validation"
Cohesion: 0.19
Nodes (21): errors, files, HTTP_METHODS, markdownCount, openApiCount, openApiOperations(), readJson(), relative() (+13 more)

### Community 15 - "CDP Broker Package"
Cohesion: 0.10
Nodes (20): bin, pw-cdp-broker, description, engines, node, exports, ./browser-manager, ./chrome (+12 more)

### Community 16 - "API Catalog"
Cohesion: 0.14
Nodes (20): brokerDelegateInstructions(), buildManifest(), controlPlaneOpenApiCatalog(), handleBrokerDelegateOpenApiRequest(), handleOpenApiRequest(), handleProxyDelegateOpenApiRequest(), handlePwDevRequest(), OPENAPI_HTTP_METHODS (+12 more)

### Community 17 - "Proxy Package"
Cohesion: 0.11
Nodes (18): bin, pw-dev-proxy, dependencies, whistle, description, engines, node, exports (+10 more)

### Community 18 - "GUI Package"
Cohesion: 0.12
Nodes (15): bin, pw-dev-gui, description, engines, node, exports, ./cli, license (+7 more)

### Community 19 - "Server Package"
Cohesion: 0.12
Nodes (15): bin, pw-dev-server, description, engines, node, exports, ./cli, license (+7 more)

### Community 20 - "CLI Package"
Cohesion: 0.13
Nodes (14): bin, pw-dev, description, engines, node, exports, license, name (+6 more)

### Community 21 - "Proxy CLI"
Cohesion: 0.30
Nodes (10): helpText(), main(), parseArgs(), parsePort(), readValue(), createProxyManager(), createPwDevRegistryClient(), normalizeHttpUrl() (+2 more)

### Community 22 - "Proxy Runtime"
Cohesion: 0.23
Nodes (12): getRunningProxy(), httpError(), optionalString(), parsePort(), parsePortRange(), requestJson(), selectPort(), spawnManagedProcess() (+4 more)

### Community 23 - "Proxy Tests"
Cohesion: 0.25
Nodes (6): deleteJson(), get(), getJson(), postJson(), putJson(), requestJson()

### Community 24 - "Broker Proxy Delegation"
Cohesion: 0.22
Nodes (11): buildUpgradeRequest(), ensureTrailingSlash(), isCdpDiscoveryPath(), proxyBrokerHttpRequest(), proxyBrokerPath(), proxyBrokerUpgrade(), proxyProxyManagerHttpRequest(), proxyProxyManagerPath() (+3 more)

### Community 25 - "Project Documentation"
Cohesion: 0.20
Nodes (8): Implementation Standard, Install, Packages, pw-dev, Run The Broker, Run The Server, Server Control Plane, Tests

### Community 26 - "Browser Lifecycle Docs"
Cohesion: 0.25
Nodes (8): Agent lease is separate from Chrome, Browser lifecycle, One browser, one live session, Stable Profile Cleanup, Proxy pool behavior, Three layers, three owners, Parallel Browser Workers, Browser Session Model

### Community 27 - "API Documentation"
Cohesion: 0.25
Nodes (9): API Documentation, App API, Browser Template API, Proxy Control-Plane API, Proxy Records API, Proxy Traffic API, pw-dev Control-Plane API, Progressive API Catalog (+1 more)

### Community 28 - "Proxy Process Cleanup"
Cohesion: 0.25
Nodes (9): cleanupOrphanedProxies(), extractManagedStorageDir(), isWithinRoot(), listProcessRecords(), omitUndefined(), recoverProxyProfiles(), removeStaleRegistryRecord(), stripChild() (+1 more)

### Community 29 - "E2E Tests"
Cohesion: 0.46
Nodes (6): makeServer(), readBody(), send(), startBrokerDouble(), startDouble(), startProxyDouble()

### Community 30 - "Browser Session Lease"
Cohesion: 0.29
Nodes (8): Session Ownership Lease, App Attach Contract, Operational implication, Reusable config, durable browser, transient session, Session ownership lease, System model, CDP Attach Workflow, Server-Origin Agent API

### Community 31 - "Agent Guide"
Cohesion: 0.29
Nodes (6): Basic Agent Usage, Install, References, Server lifecycle, Start The Broker, Start The Server

### Community 32 - "Test Documentation"
Cohesion: 0.29
Nodes (3): E2E test design, Index, pw-dev knowledge notes

### Community 33 - "Server Architecture"
Cohesion: 0.33
Nodes (6): Project Overview, Persisted Control Plane Architecture, OpenAPI Catalog, Proxy Broker Bridge, Server Registry Construction Hub, Control plane

### Community 34 - "Architecture Components"
Cohesion: 0.40
Nodes (6): Components, Contracts, Design Rules, Multi-App Flow, pw-dev Architecture, Runtime Flow

### Community 35 - "User Journeys"
Cohesion: 0.33
Nodes (6): 1. Verify an app change in a persistent browser, 2. Run two independent workers against one app, 3. Allocate isolated traffic for parallel checks, 4. Restart without losing app intent, 5. Recover ownership after an abandoned agent, Real user journeys

### Community 36 - "Knowledge Base Workflows"
Cohesion: 0.40
Nodes (5): Knowledge Base CI, Black Box E2E Testing, Deterministic Broker and Proxy Doubles, Persistent Browser App Verification, Durable Knowledge Layer

### Community 37 - "Query History"
Cohesion: 0.40
Nodes (4): Answer, Outcome, Q: Why does startPwDevServer() connect Server Registry to OpenAPI Catalog, File and JSON Utilities, HTTP Test Helpers, Proxy Manager, and Proxy Broker Bridge, Source Nodes

### Community 38 - "Proxy Pool"
Cohesion: 0.40
Nodes (5): Proxy Pool Reservation, Isolated Proxy Traffic, Proxy Pool Lease, Atomic Proxy Rules Update, Durable Whistle Profile

### Community 39 - "GUI Monitor"
Cohesion: 0.40
Nodes (5): Pea Logo, pw-dev Dashboard, Dashboard Entity Views, DOM Monitor Inspector, Live DOM Snapshot

### Community 40 - "Proxy Lifecycle"
Cohesion: 0.50
Nodes (5): Durable Profile Lifecycle Principle, Managed Proxy Lifecycle API, Managed Proxy API, Managed Proxy Ruleset API, Proxy Delegate API

### Community 41 - "Proxy HTTP Server"
Cohesion: 0.50
Nodes (5): createProxyManagerHttpServer(), handleProxyManagerRequest(), readJsonBody(), writeJson(), writeMethodNotAllowed()

### Community 42 - "API Router"
Cohesion: 0.67
Nodes (4): findApiOperation(), handleApiRequest(), pwDevApi(), pwDevApiDetails()

### Community 43 - "Server Documentation"
Cohesion: 1.00
Nodes (3): pw-dev Server Guide, Agent-facing Server Control Plane, Remote Linux Brokers

### Community 44 - "CDP Concepts"
Cohesion: 0.67
Nodes (3): Chrome DevTools Protocol Endpoint, Persistent Browser Profile, pw-cdp-broker

## Knowledge Gaps
- **185 isolated node(s):** `name`, `version`, `private`, `description`, `type` (+180 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `startPwDevServer()` connect `Server Registry State` to `Browser API`, `Remote Broker SSH`, `Server CLI`, `Knowledge Base Validation`, `API Catalog`, `Broker Proxy Delegation`, `E2E Tests`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._
- **Why does `main()` connect `CDP Broker Lifecycle` to `Broker Server`, `CLI Dispatcher`, `Network Management`, `Proxy Forwarding`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _185 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Dashboard Client` be split into smaller, more focused modules?**
  _Cohesion score 0.05542283803153368 - nodes in this community are weakly interconnected._
- **Should `CLI Dispatcher` be split into smaller, more focused modules?**
  _Cohesion score 0.06666666666666667 - nodes in this community are weakly interconnected._
- **Should `CDP Broker Lifecycle` be split into smaller, more focused modules?**
  _Cohesion score 0.08182349503214495 - nodes in this community are weakly interconnected._
- **Should `Server Registry State` be split into smaller, more focused modules?**
  _Cohesion score 0.07164404223227752 - nodes in this community are weakly interconnected._