---
type: "query"
date: "2026-08-26T16:09:07.750215+00:00"
question: "Which GUI files implement the left navigation menu, view selection, layout styles, and their tests?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["showView()", "app.js", "gui.test.js"]
---

# Q: Which GUI files implement the left navigation menu, view selection, layout styles, and their tests?

## Answer

Expanded from original query via vocab: [gui, sidebar, navigation, view, show, toggle, browser, browsers, asset, assets]. The graph identifies packages/gui/public/app.js (showView) for navigation behavior, packages/gui/public/styles.css for layout, packages/gui/public/index.html for the menu markup, and packages/gui/test/gui.test.js for regression coverage. The existing monitor sidebar is a separate monitor view.

## Outcome

- Signal: useful

## Source Nodes

- showView()
- app.js
- gui.test.js