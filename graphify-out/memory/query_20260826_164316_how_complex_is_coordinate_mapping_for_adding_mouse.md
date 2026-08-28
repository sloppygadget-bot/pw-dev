---
type: "query"
date: "2026-08-26T16:43:16.024460+00:00"
question: "How complex is coordinate mapping for adding mouse input to the JPEG monitor?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["clickMarker", "BrowserMonitorHub", "handleEvent()"]
---

# Q: How complex is coordinate mapping for adding mouse input to the JPEG monitor?

## Answer

Expanded from original query via vocab: [monitor, preview, click, marker, viewport, event]. The existing placeClickMarker() already uses the image rectangle, object-fit contain scale, and viewport dimensions to map remote clicks into the displayed JPEG. Viewer input can invert that same transform, reject letterbox clicks, and send remote CSS-pixel coordinates. The mapping itself is small; the harder work is authenticated control mode, keyboard semantics, and end-to-end testing.

## Outcome

- Signal: useful

## Source Nodes

- clickMarker
- BrowserMonitorHub
- handleEvent()