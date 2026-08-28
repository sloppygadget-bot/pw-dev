---
type: "query"
date: "2026-08-26T16:15:45.674352+00:00"
question: "Which browser diagram elements and styles control a responsive two-column browser-card grid?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["renderBrowserDiagram()", "renderBrowsers()", "app.js"]
---

# Q: Which browser diagram elements and styles control a responsive two-column browser-card grid?

## Answer

Expanded from original query via vocab: [browser, browsers, diagram, preview, view]. The graph identifies renderBrowserDiagram() and renderBrowsers() in packages/gui/public/app.js as the card renderer and packages/gui/public/styles.css as the browser diagram layout surface. The browser dashboard uses a root browser-card grid with a details/preview split inside each card.

## Outcome

- Signal: useful

## Source Nodes

- renderBrowserDiagram()
- renderBrowsers()
- app.js