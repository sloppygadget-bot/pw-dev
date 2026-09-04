# GUI Quality Pass Design

## Goal

Make the pw-dev dashboard and screenshot monitor reliable, clean, compact,
responsive, and keyboard-accessible while preserving their current
dependency-light architecture and restrained light admin-console character.

## Scope

This pass covers the GUI server, dashboard, screenshot monitor, and their
browser-level tests. It addresses defects reproduced against the live services
at ports 9696, 9797, and 18080 as well as visible layout and interaction issues
observed at 1920, 1440, and 390 CSS-pixel widths.

The pass does not introduce a frontend framework, a component library, a new
API schema, dark mode, persistent UI preferences, or a replacement for Swagger
UI. It does not change the control-plane ownership model or the 1920x1080
minimum for the page being monitored.

## Audited Problems

### Reliability

1. When the dashboard is opened inside a managed browser, its preview page
   selection can choose the dashboard itself. The preview then recursively
   captures the dashboard and applies the monitored-page 1920x1080 minimum to
   the operator tab.
2. The monitor hub implicitly lets Playwright auto-dismiss JavaScript dialogs.
   When another Playwright client handles the same dialog, the two clients can
   race on `Page.handleJavaScriptDialog`. The losing protocol command rejects
   without a handler and crashes the GUI process. This was reproduced during a
   real create/start/monitor/stop/delete workflow; the original 9797 process
   exited with `Protocol error (Page.handleJavaScriptDialog): No dialog is
   showing`.
3. A failed `/api/snapshot` request is only visible as an unhandled browser
   error. Initial failure leaves mutation controls disabled with `Server:
   Unknown`; a later polling failure leaves stale data looking healthy.
4. A polling failure exits the timer callback before `schedule()` runs. A
   subsequent successful manual refresh does not resume automatic polling.
5. The monitor document has no favicon declaration, causing a 404 for
   `/favicon.ico`.

### Layout and visual hierarchy

1. A single browser diagram occupies only half of a wide content area, leaving
   large unused space and forcing the card into its narrow one-column internal
   layout.
2. All table cells use `white-space: nowrap`. One ordinary browser-config row
   measured more than 2,000 CSS pixels wide at a 1440-pixel viewport, placing
   actions beyond the visible content area.
3. On a 390-pixel dashboard, four full-width status cards and expanded entity
   navigation consume most of the first screen before the active view begins.
4. Browser-card actions precede the browser title, weakening scan order and
   hierarchy. Primary, secondary, destructive, and disabled actions are styled
   nearly identically; disabled actions retain a pointer cursor and full
   opacity.
5. Several labels and empty states are mechanically worded: the refresh
   interval and manual action are both called “Refresh,” broker titles render
   as `BROKER1`, and unrelated empty views all say “No records.”
6. The checkbox accent references an undefined `--accent` token.

### Monitor responsiveness

1. At mobile widths, `.monitor-brand` retains a desktop flex basis based on
   viewport width. In the column topbar this becomes excess vertical space and
   makes the header roughly 225 pixels tall.
2. The mobile mirror keeps a `70vh` fixed height while rendering a landscape
   1920x1080 image with `object-fit: contain`, creating a large blank region
   above and below the actual screenshot.
3. The browser controls and address field stack even though they fit on one
   compact row at common phone widths.

### Accessibility

1. The active entity navigation item does not expose `aria-current`, and the
   Diagram/Table toggle does not expose `aria-pressed`.
2. Refresh state and failures are not announced through a live status region.
3. The README modal focuses its Close button on open but does not contain Tab
   focus. After two Tab presses focus can reach `body` behind the modal.
4. Closing the README modal leaves focus on `body` instead of returning it to
   the button that opened the dialog.
5. Focus, disabled, and destructive states are not consistently visible across
   buttons, links, inputs, and entity rows.

## Design Principles

- Preserve the current server-rendered static asset model and plain JavaScript.
- Fix causes at component boundaries rather than masking symptoms with delays.
- Keep the last useful state visible during transient failures.
- Make dense operational information scannable without hiding it.
- Use responsive reflow for primary content and explicit horizontal scrolling
  only for genuinely wide tables.
- Keep every destructive control text-labeled and confirmation-protected.
- Prefer behavioral browser tests over source-text assertions.

## Detailed Design

### 1. Safe monitored-page selection

The GUI server will identify its own request origin and make that origin
available to the monitor hub. Page inventories used for automatic selection
will exclude dashboard, API-doc, and monitor pages served from a known GUI
origin. An explicitly supplied non-GUI CDP page ID remains authoritative.

The dashboard will also filter same-origin GUI pages before choosing a preview
page or rendering page selectors. It will not call the preview endpoint without
a selected external page. If a managed browser contains only GUI pages, its
card will display a contextual empty state asking the operator to open a target
page. This prevents the initial self-preview connection as well as the recursive
screenshot.

The monitor will omit GUI pages from its page picker. If the selected target
closes, backend fallback will choose the first remaining non-GUI page. If none
exists, it will report that no monitorable page is open instead of selecting the
monitor itself.

The exclusion is origin-scoped, not a blanket localhost filter. A user may
still monitor unrelated localhost applications.

### 2. Dialog-safe monitor connections

Every page observed by `BrowserMonitorHub` will receive one explicit dialog
handler. The handler preserves the existing effective behavior—unattended
dialogs are dismissed—but owns the returned promise and catches the expected
“dialog already handled” race. A competing CDP client may accept or dismiss the
dialog without turning the monitor hub’s losing command into an unhandled
rejection.

Dialog handling remains browser-wide because CDP dialog events are
browser-client-wide even when the monitor is capturing one page. The handler
must be installed once per Playwright Page through the existing `observedPages`
guard, and it must never throw into the process event loop.

### 3. Recoverable dashboard refreshes

The dashboard will add a compact `role="status"`, `aria-live="polite"` refresh
indicator in the topbar. It will distinguish Loading, Up to date, and a concise
failure state. A failure will retain the last successful snapshot and timestamp
while clearly stating that the latest refresh failed.

`performRefresh()` will convert snapshot failures into an explicit result after
updating the indicator. It will always re-enable controls in `finally`.
Initialization will enable controls after configuration is available even if
the first snapshot fails, allowing recovery without a full page reload.

The timer callback will schedule its next attempt in `finally`, so transient
failures cannot stop polling. A manual refresh will reset the interval after it
settles, avoiding an immediate redundant scheduled refresh. Successful recovery
will clear the failure state without replacing content until a decoded and
normalized snapshot is ready.

### 4. Dashboard layout and visual system

The existing neutral palette will be retained and completed with explicit
accent, focus-ring, radius, and shadow tokens. Buttons will have consistent
base, hover, focus-visible, disabled, primary, and danger treatments. New/Save
actions are primary; Cancel and ordinary actions are secondary; Delete actions
are danger-styled without relying on color alone. Disabled controls use reduced
contrast and `cursor: not-allowed`.

Browser cards will use an auto-fit grid. One browser expands to the available
content width; multiple browsers form two columns only when each can retain a
useful minimum width. Inside a card, title and occupancy lead on the left and
actions align on the right, wrapping below on narrow containers. The dependency
flow and preview remain the two primary columns when space permits.

Entity tables will wrap long values and constrain verbose columns rather than
forcing every token onto one line. IDs and URLs may break at safe boundaries.
Tables retain their scroll container and a deliberate minimum width where the
number of columns genuinely requires horizontal scrolling. This keeps all
actions discoverable at desktop widths and preserves data density on phones.

Copy changes are limited to clarity:

- “Auto refresh” labels the interval selector.
- “Refresh now” labels the manual action.
- Broker cards use “Broker 1”, “Broker 2”, and so on.
- Empty states name the missing entity, such as “No apps” or “No proxies.”

### 5. Responsive behavior

At widths up to 850 pixels, status cards become a compact two-by-two grid rather
than four stacked full-width cards. Main padding, gaps, and metric height reduce
slightly. Entity navigation becomes a predictable single-column accordion;
only the active group is forced open by navigation. Section actions wrap without
making every control full-width.

At widths up to 620 pixels, the monitor brand resets its flex basis to content
size. The topbar keeps the title, live state, dashboard link, and manual refresh
visible in a compact wrap. Browser controls and the ellipsized address remain on
one row.

The mobile mirror uses the decoded image’s intrinsic aspect ratio. It has a
small loading minimum before the first image arrives, then grows only as needed
up to a viewport-relative maximum. The 1920x1080 remote viewport is unchanged;
only the local presentation stops reserving unused portrait height.

### 6. Accessible interaction state

`showView()` will maintain `aria-current="page"` on exactly one entity
navigation button. Browser view buttons will maintain mutually exclusive
`aria-pressed` values. Refresh status changes will be announced politely without
moving focus.

Opening the README modal will remember the invoking element, mark the page shell
inert, and focus the Close button. Tab and Shift+Tab will cycle among enabled
focusable controls inside the dialog. Escape, backdrop click, and Close will use
one close path that removes inert state and restores focus to the invoking
element when it is still connected.

All interactive elements will receive a consistent visible keyboard focus ring.
Touch targets for compact page selectors will increase without making their
visual dots disproportionately large.

### 7. Static asset hygiene

The monitor document will reference the existing SVG favicon explicitly. Static
asset requests made during a healthy dashboard or monitor load must complete
without console errors or unexpected 404 responses.

## Testing Strategy

### Automated behavior tests

1. Establish a monitor connection to a real Chromium instance from one client,
   handle a confirm dialog from a second client, and prove that the monitor hub
   catches the competing dialog result, remains usable, and closes cleanly.
2. Open the dashboard inside a managed browser containing one external page and
   one GUI page. Prove the external target is selected, the GUI page is absent
   from preview selectors, and the GUI page viewport is not raised to 1920x1080.
3. Return a successful snapshot, one failed snapshot, then another successful
   snapshot. Prove stale content remains visible, a visible error is announced,
   automatic polling continues, and recovery clears the error.
4. Exercise README modal Tab, Shift+Tab, Escape, backdrop, and focus restoration
   against the real dashboard script.
5. Verify `aria-current`, `aria-pressed`, enabled/disabled classes, and
   contextual empty-state text through rendered behavior.
6. At 1440 and 390 pixel viewports, assert no page-level horizontal overflow,
   usable browser-card expansion, compact status layout, reachable table
   actions, compact monitor header, and an intrinsic-height mirror.
7. Load dashboard and monitor documents and assert that there are no page
   errors, failed same-origin asset requests, or unexpected 4xx/5xx responses.

Each production behavior change will follow a red-green-refactor cycle. Tests
will assert rendered state and runtime effects rather than grep implementation
text.

### Full verification

- `npm run check:kb`
- `npm test`
- `npm run test:e2e`
- `git diff --check`
- Independent read-only code review

### Live acceptance

Against the existing real environment:

1. Confirm 9696, 9797, and the broker are healthy and owned by this checkout.
2. Preserve the user’s original `google-local` page and use cooperative leases
   for every mutating browser operation.
3. Verify dashboard diagram/table/entity navigation and monitor behavior at
   desktop and mobile widths with no console or network errors.
4. Run a temporary GUI-created standalone browser lifecycle: create config,
   create browser, start, open monitor, exercise a confirmation dialog, stop,
   delete browser, and delete config.
5. Confirm the 9797 process remains healthy after dialog handling.
6. Remove only the temporary audit resources, release every lease, and verify
   `google-local` is unclaimed and restored to its original URL.
7. Capture final desktop and mobile screenshots for visual inspection.

## Compatibility and Rollout

All changes remain inside `packages/gui` plus human documentation. Existing
control-plane APIs, browser records, profiles, sessions, and monitor URLs remain
compatible. No migration or new dependency is required. The live GUI process
must be restarted after server-side monitor changes; dashboard and monitor
static assets then load from the same 9797 origin.

The branch will be committed locally after automated and live verification. It
will not be pushed or merged without an explicit integration choice.
