---
type: "query"
date: "2026-08-26T16:40:42.488214+00:00"
question: "Can the current JPEG browser monitor relay mouse and keyboard input to a remote browser?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["BrowserMonitorHub", "handleEvent()", "clickMarker"]
---

# Q: Can the current JPEG browser monitor relay mouse and keyboard input to a remote browser?

## Answer

Expanded from original query via vocab: [monitor, preview, click, input, event, page, browser, remote, action, actions]. The monitor client renders JPEG previews and remote click telemetry but does not listen for pointer or keyboard input. The server has POST /api/monitor/:browserId/action for limited DOM-path actions (click, focus, highlight, scrollIntoView), while BrowserMonitorHub connects through CDP to a live page. Coordinate mouse and keyboard relay would require explicit new handlers and a control/authorization boundary.

## Outcome

- Signal: useful

## Source Nodes

- BrowserMonitorHub
- handleEvent()
- clickMarker