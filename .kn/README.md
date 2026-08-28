# pw-dev knowledge notes

This directory is the small, durable knowledge layer for `pw-dev`.

Notes follow a Karpathy-style working set:

- one durable idea per note;
- concrete nouns and verbs from the codebase;
- a short operational consequence;
- explicit provenance (`EXTRACTED`, `INFERRED`, or `AMBIGUOUS`);
- links back to the source file, API document, or graphify output.

The notes are deliberately more useful than a generated code summary: they
capture what an agent needs to do, observe, and clean up during a real task.
Refresh them after a meaningful lifecycle or API change. `graphify-out/` is the
discovery/audit source; the implementation and OpenAPI files remain the source
of truth for behavior.

## Sync contract

Keep a note synchronized when one of its cited lifecycle, OpenAPI, or monitor
sources changes. Update the note's operational consequence and provenance with
the code change; do not turn this directory into a line-by-line generated
summary. CI validates cited source paths and, when a comparison base is
available, requires the affected durable notes to change with their contract
sources.

## Index

- [system](system.md) — the control-plane model and ownership boundaries.
- [journeys](journeys.md) — practical agent/user journeys and acceptance checks.
- [browser-lifecycle](browser-lifecycle.md) — reusable browser configuration,
  session ownership, and cleanup semantics.
- [e2e-rationale](e2e-rationale.md) — why the E2E suite uses public APIs and local doubles.
