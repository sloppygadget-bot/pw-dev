---
type: "query"
date: "2026-08-26T16:45:41.113170+00:00"
question: "Where should the GUI show the broker wired to each browser config?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["renderBrowserConfigs()", "render()", "app.js"]
---

# Q: Where should the GUI show the broker wired to each browser config?

## Answer

Expanded from original query via vocab: [broker, browser, config, configs, default, render, table, url, view]. The Browser Configs table is rendered by renderBrowserConfigs() in packages/gui/public/app.js. Browser configs carry optional brokerUrl values, while the snapshot provides discovered/default brokers. The table now shows the explicit broker URL or falls back to the configured default broker.

## Outcome

- Signal: useful

## Source Nodes

- renderBrowserConfigs()
- render()
- app.js