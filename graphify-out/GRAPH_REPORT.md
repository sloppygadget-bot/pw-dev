# Graph Report - /home/pengxie/work/pw-dev  (2026-08-24)

## Corpus Check
- 135 files · ~126,481 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 935 nodes · 1836 edges · 78 communities (44 shown, 34 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 28 edges (avg confidence: 0.65)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- app js
- gui src server js
- cdp broker src cli js
- remote brokers js
- public monitor js
- server src index js
- handlePwDevRequest
- scripts
- proxy src index js
- cdp broker src server js
- throwValidationError
- networks js
- handleBrowsersRequest
- proxy forwards js
- startPwDevServer
- check kb mjs
- cdp broker package json
- proxy package json
- gui package json
- server package json
- server test server test js
- cli package json
- pw dev e2e test js
- recoverProxyProfiles
- createProxyManager
- httpError
- proxy test js
- ssh assets js
- server src cli js
- Artificial intelligence
- Parrot Push and Pull Interactive
- CDP Broker
- Browser Session Isolation
- Playwright Execution Trace
- pw dev Server API
- Server Registry Construction Hub
- Browser Lifecycle Layers
- Demo Pet Store
- pw dev Control Plane Skill
- E2E Testing Rationale
- Proxy Pool Lease
- Whistle Proxy Manager
- Durable Browser
- Fortinet Password Login
- Request Mocking
- Video Recording
- Knowledge Base CI
- Session Ownership Lease
- GUI API Documentation Catalog
- DOM Monitor Inspector
- Demo Pet Store Cart Page
- pw dev Project Overview
- pw dev Control Plane Agent
- Inspecting Element Attributes
- Running Playwright Tests
- Running Custom Playwright Code
- Test Generation
- playwright cli Browser Automation Skill
- pw dev Example Static Site
- Persistent Browser App Verification
- Restart Persistence
- App Attach Contract
- pw cdp broker
- Pea Logo
- Agent Instructions
- Empty Page Snapshot
- Google Home Snapshot
- Google Home Snapshot
- Google Home Snapshot
- Google Search Results Snapshot
- Google Search Page Snapshot
- Google Search Page Snapshot
- Google Search Page Snapshot
- Demo Pet Store Home Page
- Fortinet KYC Network
- Fortinet KYC Search
- Fortinet KYC View
- Fortinet KYC Detail

## God Nodes (most connected - your core abstractions)
1. `startPwDevServer()` - 33 edges
2. `throwValidationError()` - 27 edges
3. `handlePwDevRequest()` - 26 edges
4. `main()` - 21 edges
5. `startPwDevGuiServer()` - 21 edges
6. `handleBrowsersRequest()` - 21 edges
7. `requiredString()` - 19 edges
8. `BrowserMonitorHub` - 18 edges
9. `writeJson()` - 18 edges
10. `omitUndefined()` - 18 edges

## Surprising Connections (you probably didn't know these)
- `Server Registry Construction Hub` --semantically_similar_to--> `Server Control Plane`  [INFERRED] [semantically similar]
  graphify-out/memory/query_20260802_070533_why_does_startpwdevserver___connect_server_registr.md → .kn/system.md
- `resolveChromiumExecutable()` --indirect_call--> `relative()`  [INFERRED]
  packages/server/src/index.js → scripts/check-kb.mjs
- `makeServer()` --calls--> `startPwDevServer()`  [EXTRACTED]
  e2e/pw-dev.e2e.test.js → packages/server/src/index.js
- `validateLiveKnowledge()` --calls--> `startPwDevServer()`  [EXTRACTED]
  scripts/check-kb.mjs → packages/server/src/index.js
- `Knowledge Base CI` --references--> `Durable Knowledge Layer`  [EXTRACTED]
  .github/workflows/ci.yml → .kn/README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Browser Configuration to Session Lifecycle** — kn_browser_lifecycle_browser_layers, kn_system_browser_session_model, kn_journeys_app_verification [EXTRACTED 1.00]
- **Playwright E2E Observability** — concept_playwright_trace, concept_video_webm, concept_storage_state [INFERRED 0.75]
- **pw-dev Contract-Oriented E2E Testing** — concept_pw_dev_server_api, concept_openapi_contract, concept_black_box_e2e, concept_deterministic_test_doubles [INFERRED 0.85]
- **Pet store navigation categories** — playwright_cli_page_2026_08_13t06_04_09_949z_demo_pet_store, playwright_cli_page_2026_08_13t06_04_09_949z_shop_by_pet, playwright_cli_page_2026_08_13t06_04_09_949z_pet_categories [EXTRACTED 1.00]
- **pw-dev Runtime Flow** — docs_architecture_app, docs_architecture_server, docs_architecture_broker, docs_architecture_chrome, docs_architecture_session [EXTRACTED 1.00]
- **Agent Browser Workflow** — packages_server_instructions_agent_browser_config, packages_server_instructions_agent_browser, packages_server_instructions_agent_session [EXTRACTED 1.00]

## Communities (78 total, 34 thin omitted)

### Community 0 - "app js"
Cohesion: 0.05
Nodes (91): actionGroup(), appendInlineMarkdown(), appLink(), badge(), browserActions(), browserConfigActions(), browserConfigLink(), browserConfigUsage() (+83 more)

### Community 1 - "gui src server js"
Cohesion: 0.06
Nodes (51): helpText(), main(), helpText(), main(), parseArgs(), parsePort(), readValue(), ALLOWED_ACTIONS (+43 more)

### Community 2 - "cdp broker src cli js"
Cohesion: 0.08
Nodes (40): booleanOption(), BrowserManager, createBrowserManager(), describeInstance(), makeInstanceId(), mergeExtraArgs(), optionOrDefault(), brokerHome() (+32 more)

### Community 3 - "remote brokers js"
Cohesion: 0.08
Nodes (42): abortError(), buildSshLocalForwardArgs(), buildSshLocalForwardCancelArgs(), buildSshRemoteBrokerBootstrapArgs(), buildSshRemoteBrokerStopArgs(), buildSshWindowsCommandArgs(), buildWindowsPowerShellCommand(), canListen() (+34 more)

### Community 4 - "public monitor js"
Cohesion: 0.08
Nodes (40): activity, addActivity(), annotatePaths(), applyPatch(), attachFrameEvents(), browserId, clickMarker, closeSidebar (+32 more)

### Community 5 - "server src index js"
Cohesion: 0.08
Nodes (38): abortError(), BROKER_PACKAGE_ROOT, buildUpgradeRequest(), cloneApp(), cloneBrowserSessions(), composeBrowserSessionId(), composeDefaultBrowserSessionId(), createNetworkRegistry() (+30 more)

### Community 6 - "handlePwDevRequest"
Cohesion: 0.09
Nodes (38): brokerDelegateInstructions(), browserConfigOccupants(), browserConfigReferences(), buildManifest(), controlPlaneOpenApiCatalog(), findApiOperation(), handleApiRequest(), handleAppsRequest() (+30 more)

### Community 7 - "scripts"
Cohesion: 0.06
Nodes (34): bin, pw-dev, dependencies, swagger-ui-dist, description, devDependencies, playwright, @playwright/cli (+26 more)

### Community 8 - "proxy src index js"
Cohesion: 0.09
Nodes (23): applyWhistleProjectRules(), cleanupManagedProxy(), cleanupProcessRecord(), createManagedRuleState(), createProxyManagerHttpServer(), createProxyStorageDir(), DEFAULT_W2_STORAGE_ROOT, delay() (+15 more)

### Community 9 - "cdp broker src server js"
Cohesion: 0.13
Nodes (27): BROKER_PACKAGE_ROOT, brokerClientSource(), brokerInstructions(), buildUpgradeRequest(), createBrokerServer(), handleControlRequest(), instanceBaseUrl(), joinUrlPath() (+19 more)

### Community 10 - "throwValidationError"
Cohesion: 0.21
Nodes (29): omitUndefined(), optionalPath(), optionalString(), requiredOneOf(), requiredPositiveInteger(), requiredString(), requiredStringAllowEmpty(), resolveBrowserStopTarget() (+21 more)

### Community 11 - "networks js"
Cohesion: 0.21
Nodes (17): createNetworkManager(), describeNetwork(), inUseBy(), NetworkManager, normalizePort(), normalizeProxyServer(), omitUndefined(), optionalString() (+9 more)

### Community 12 - "handleBrowsersRequest"
Cohesion: 0.14
Nodes (25): brokerJson(), browserProfile(), buildAppResponse(), buildBrowserResponse(), chooseBrowserProxy(), createSessionLease(), ensureManagedProxyRunning(), findActiveBrowserProfile() (+17 more)

### Community 13 - "proxy forwards js"
Cohesion: 0.17
Nodes (10): buildProxySshArgs(), describeForward(), inUseBy(), makeForwardId(), normalizePort(), normalizeProbeHost(), normalizeProbePort(), normalizeProbeTimeout() (+2 more)

### Community 14 - "startPwDevServer"
Cohesion: 0.11
Nodes (23): closeHttpServer(), createAppRegistry(), createBrokerPairing(), createBrowserConfigRegistry(), createBrowserRegistry(), createProxyRegistry(), createSessionRegistry(), defaultAppId() (+15 more)

### Community 15 - "check kb mjs"
Cohesion: 0.19
Nodes (21): errors, files, HTTP_METHODS, markdownCount, openApiCount, openApiOperations(), readJson(), relative() (+13 more)

### Community 16 - "cdp broker package json"
Cohesion: 0.10
Nodes (20): bin, pw-cdp-broker, description, engines, node, exports, ./browser-manager, ./chrome (+12 more)

### Community 17 - "proxy package json"
Cohesion: 0.11
Nodes (18): bin, pw-dev-proxy, dependencies, whistle, description, engines, node, exports (+10 more)

### Community 18 - "gui package json"
Cohesion: 0.12
Nodes (15): bin, pw-dev-gui, description, engines, node, exports, ./cli, license (+7 more)

### Community 19 - "server package json"
Cohesion: 0.12
Nodes (15): bin, pw-dev-server, description, engines, node, exports, ./cli, license (+7 more)

### Community 20 - "server test server test js"
Cohesion: 0.20
Nodes (11): deleteJson(), get(), getJson(), patchJson(), postJson(), readRequestJson(), requestJson(), startMockBroker() (+3 more)

### Community 21 - "cli package json"
Cohesion: 0.13
Nodes (14): bin, pw-dev, description, engines, node, exports, license, name (+6 more)

### Community 22 - "pw dev e2e test js"
Cohesion: 0.25
Nodes (12): assertJsonSchema(), createOpenApiContract(), findOperation(), makeServer(), pathMatches(), readBody(), REPOSITORY_ROOT, resolveSchema() (+4 more)

### Community 23 - "recoverProxyProfiles"
Cohesion: 0.16
Nodes (14): adoptManagedProxyProcess(), cleanupOrphanedProxies(), extractManagedStorageDir(), findManagedProxyProcess(), isWithinRoot(), listProcessRecords(), managedProcessesByStorageDir(), markProxyStopped() (+6 more)

### Community 24 - "createProxyManager"
Cohesion: 0.30
Nodes (10): helpText(), main(), parseArgs(), parsePort(), readValue(), createProxyManager(), createPwDevRegistryClient(), normalizeHttpUrl() (+2 more)

### Community 25 - "httpError"
Cohesion: 0.23
Nodes (12): getRunningProxy(), httpError(), optionalString(), parsePort(), parsePortRange(), requestJson(), selectPort(), spawnManagedProcess() (+4 more)

### Community 26 - "proxy test js"
Cohesion: 0.25
Nodes (6): deleteJson(), get(), getJson(), postJson(), putJson(), requestJson()

### Community 27 - "ssh assets js"
Cohesion: 0.39
Nodes (7): byId(), createSshAssetRegistry(), identifier(), invalid(), load(), optional(), required()

### Community 28 - "server src cli js"
Cohesion: 0.52
Nodes (5): helpText(), main(), parseArgs(), parsePort(), readValue()

### Community 29 - "Artificial intelligence"
Cohesion: 0.29
Nodes (7): AI applications, Artificial intelligence, ChatGPT, Google AI, Google Gemini, OpenAI, Perplexity AI

### Community 30 - "Parrot Push and Pull Interactive"
Cohesion: 0.29
Nodes (7): Birds collection, Birds, Gingerain Bird clothes, Outdoor Bird backpack With feeder, Parrot Push and Pull Interactive toy, Polycarbonate, Wood Climbing Ladder with Grinded Coconut Shell

### Community 31 - "CDP Broker"
Cohesion: 0.33
Nodes (6): App Devserver, CDP Broker, Chrome, pw-dev Server, Transient Session, Broker Delegate Instructions

### Community 32 - "Browser Session Isolation"
Cohesion: 0.50
Nodes (4): Browser Session Management, Storage Management, Browser Session Isolation, Storage State

### Community 33 - "Playwright Execution Trace"
Cohesion: 0.50
Nodes (4): Spec-driven Testing, Playwright Tracing, Playwright Execution Trace, Plan Generate Heal Workflow

### Community 34 - "pw dev Server API"
Cohesion: 0.50
Nodes (4): pw-dev Architecture, pw-dev Server API, Remote Broker Provisioning, pw-dev README

### Community 35 - "Server Registry Construction Hub"
Cohesion: 0.50
Nodes (4): OpenAPI Catalog, Proxy Broker Bridge, Server Registry Construction Hub, Server Control Plane

### Community 36 - "Browser Lifecycle Layers"
Cohesion: 0.50
Nodes (4): Browser Lifecycle Layers, Stable Profile Cleanup, Parallel Browser Workers, Browser Session Model

### Community 37 - "Demo Pet Store"
Cohesion: 0.50
Nodes (4): Demo Pet Store, Gift cards, Pet categories, Shop by pet

### Community 38 - "pw dev Control Plane Skill"
Cohesion: 0.67
Nodes (3): pw-dev Control Plane Skill, Live OpenAPI Contract, pw-dev Server API

### Community 39 - "E2E Testing Rationale"
Cohesion: 0.67
Nodes (3): Black-box E2E Testing, Deterministic Broker and Proxy Doubles, E2E Testing Rationale

### Community 40 - "Proxy Pool Lease"
Cohesion: 0.67
Nodes (3): Proxy Pool Reservation, Isolated Proxy Traffic, Proxy Pool Lease

### Community 41 - "Whistle Proxy Manager"
Cohesion: 0.67
Nodes (3): Durable Whistle Profile, Whistle Proxy Manager, Proxy Delegate Instructions

### Community 42 - "Durable Browser"
Cohesion: 0.67
Nodes (3): Durable Browser, Browser Config, Session Lease

### Community 43 - "Fortinet Password Login"
Cohesion: 0.67
Nodes (3): Fortinet Username Login, Fortinet Password Login, Fortinet Token Login

## Knowledge Gaps
- **217 isolated node(s):** `REPOSITORY_ROOT`, `name`, `version`, `private`, `type` (+212 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **34 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `startPwDevServer()` connect `startPwDevServer` to `remote brokers js`, `server src index js`, `handlePwDevRequest`, `check kb mjs`, `server test server test js`, `pw dev e2e test js`, `ssh assets js`, `server src cli js`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **Why does `main()` connect `cdp broker src cli js` to `cdp broker src server js`, `networks js`, `gui src server js`?**
  _High betweenness centrality (0.024) - this node is a cross-community bridge._
- **What connects `REPOSITORY_ROOT`, `name`, `version` to the rest of the system?**
  _217 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `app js` be split into smaller, more focused modules?**
  _Cohesion score 0.05241228070175439 - nodes in this community are weakly interconnected._
- **Should `gui src server js` be split into smaller, more focused modules?**
  _Cohesion score 0.06018018018018018 - nodes in this community are weakly interconnected._
- **Should `cdp broker src cli js` be split into smaller, more focused modules?**
  _Cohesion score 0.07879428873611846 - nodes in this community are weakly interconnected._
- **Should `remote brokers js` be split into smaller, more focused modules?**
  _Cohesion score 0.0784313725490196 - nodes in this community are weakly interconnected._