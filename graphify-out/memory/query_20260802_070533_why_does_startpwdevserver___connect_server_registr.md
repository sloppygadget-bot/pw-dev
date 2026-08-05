---
type: "query"
date: "2026-08-02T07:05:33.391373+00:00"
question: "Why does startPwDevServer() connect Server Registry to OpenAPI Catalog, File and JSON Utilities, HTTP Test Helpers, Proxy Manager, and Proxy Broker Bridge"
contributor: "graphify"
outcome: "useful"
source_nodes: ["startPwDevServer()", "handlePwDevRequest()", "controlPlaneOpenApiCatalog()", "createAppRegistry()", "proxyBrokerUpgrade()"]
---

# Q: Why does startPwDevServer() connect Server Registry to OpenAPI Catalog, File and JSON Utilities, HTTP Test Helpers, Proxy Manager, and Proxy Broker Bridge

## Answer

Expanded graph query tokens: start server registry openapi catalog file json http test proxy manager broker. The graph shows startPwDevServer() as a central server-construction hub: it initializes persistent app/browser/proxy registries and sessions; closes over handlePwDevRequest(), which serves the OpenAPI catalog and delegates; configures proxy-manager routing; and installs the broker WebSocket upgrade bridge. Its File and JSON Utilities and HTTP Test Helpers links are mostly implementation/test-support and import relationships, not runtime calls from the production server. The graph's community connections therefore combine real server architecture with test and tooling dependencies.

## Outcome

- Signal: useful

## Source Nodes

- startPwDevServer()
- handlePwDevRequest()
- controlPlaneOpenApiCatalog()
- createAppRegistry()
- proxyBrokerUpgrade()