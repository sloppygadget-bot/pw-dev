# GUI Quality Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the pw-dev dashboard and screenshot monitor reliable, clean, compact, responsive, and keyboard-accessible in both automated and real managed-browser use.

**Architecture:** Keep the existing dependency-light Node HTTP server and plain HTML/CSS/JavaScript frontend. Add origin-aware page filtering and owned dialog handling at the monitor-hub boundary, then make dashboard refresh, preview selection, modal behavior, and responsive presentation explicit in the static client. Extend the existing Node test file with Playwright behavior tests so each production change is driven by a failing test.

**Tech Stack:** Node.js 18+, `node:http`, `node:test`, Playwright/Chromium, browser-native HTML/CSS/JavaScript

**Spec:** `docs/superpowers/specs/2026-09-04-gui-quality-pass-design.md`

## Global Constraints

- Preserve the current server-rendered static asset model and plain JavaScript.
- Do not introduce a frontend framework, component library, new dependency, new API schema, migration, dark mode, or persistent UI preference.
- Do not change the control-plane ownership model or the 1920x1080 minimum for a page that is actually monitored.
- Exclude only pages served from known GUI origins; unrelated localhost applications remain monitorable.
- Keep the last useful dashboard snapshot and browser thumbnail visible through transient failures.
- Use `role="status"` with `aria-live="polite"` for refresh state and restore modal focus to its invoker.
- Use the copy “Auto refresh,” “Refresh now,” “Broker 1,” and entity-specific empty states.
- Run every production behavior change through a red-green-refactor cycle.
- Preserve the user’s `google-local` browser, original page URL, and unclaimed occupancy during live acceptance.
- Do not push or merge the branch without an explicit integration choice.

## File Structure

- Modify `packages/gui/src/monitor.js`: own dialog dismissal, track GUI origins, filter monitorable pages, and refuse GUI-only sessions.
- Modify `packages/gui/src/server.js`: register the bound GUI origin and request-host aliases with the monitor hub.
- Modify `packages/gui/public/index.html`: add refresh status semantics, stable page-shell boundary, button variants, and initial ARIA state.
- Modify `packages/gui/public/app.js`: recover refresh polling, filter GUI preview pages, maintain ARIA state, restore modal focus, and apply contextual action/empty-state classes.
- Modify `packages/gui/public/styles.css`: complete visual tokens, button hierarchy, responsive dashboard/card/table layout, focus styles, and modal inert presentation.
- Modify `packages/gui/public/monitor.html`: add the favicon and live-status semantics.
- Modify `packages/gui/public/monitor.css`: compact the mobile topbar/toolbar and size the mirror from its image aspect ratio.
- Modify `packages/gui/public/monitor.js`: expose loaded-image aspect ratio to CSS and retain the prior screenshot until the next image decodes.
- Modify `packages/gui/test/gui.test.js`: add all unit, browser-behavior, accessibility, responsive-layout, and static-asset regressions.

---

### Task 1: Origin-aware monitor target selection

**Files:**
- Modify: `packages/gui/src/monitor.js:26-40,187-242,283-322`
- Modify: `packages/gui/src/server.js:32-45,56-85,139-142`
- Test: `packages/gui/test/gui.test.js:330-424,1443-1541`

**Interfaces:**
- Consumes: browser page descriptors shaped as `{ id, title, url, page }`.
- Produces: `BrowserMonitorHub.addGuiOrigin(origin: string): void`, `BrowserMonitorHub.monitorablePages(browser): Promise<PageDescription[]>`, and a `409` error with message `Browser session has no monitorable page` when only GUI pages exist.
- Produces: server-side calls to optional `monitorHub.addGuiOrigin?.(origin)` so existing monitor-hub test doubles remain compatible.

- [ ] **Step 1: Add failing hub tests for GUI-page exclusion and external-page fallback**

Add tests beside the existing multi-page monitor tests; its page double already
exposes `viewportSize()` and `setViewportSize()`.

```js
test('monitor excludes known GUI pages from selection, inventory, and viewport changes', async () => {
  const browserDouble = createMonitorBrowserDouble([
    { id: 'dashboard', title: 'pw-dev', url: 'http://127.0.0.1:9797/', viewport: { width: 390, height: 844 } },
    { id: 'target', title: 'Target', url: 'http://127.0.0.1:3000/', viewport: { width: 1024, height: 768 } },
    { id: 'monitor', title: 'Monitor', url: 'http://127.0.0.1:9797/monitor/gui-browser', viewport: { width: 390, height: 844 } },
  ]);
  const hub = createConnectedMonitorHub(browserDouble, 'gui-session');
  hub.addGuiOrigin('http://127.0.0.1:9797');

  try {
    const connection = await hub.ensureConnection('gui-browser');
    assert.equal(connection.pageId, 'target');
    assert.deepEqual(browserDouble.page('target').viewportSize(), { width: 1920, height: 1080 });
    assert.deepEqual(browserDouble.page('dashboard').viewportSize(), { width: 390, height: 844 });
    assert.deepEqual(browserDouble.page('monitor').viewportSize(), { width: 390, height: 844 });
    assert.deepEqual((await hub.refreshPageInventory(connection)).map((page) => page.id), ['target']);
  } finally {
    await hub.close();
  }
});

test('monitor reports a GUI-only session instead of resizing the operator page', async () => {
  const browserDouble = createMonitorBrowserDouble([
    { id: 'dashboard', title: 'pw-dev', url: 'http://127.0.0.1:9797/', viewport: { width: 390, height: 844 } },
  ]);
  const hub = createConnectedMonitorHub(browserDouble, 'gui-only-session');
  hub.addGuiOrigin('http://127.0.0.1:9797');

  await assert.rejects(hub.ensureConnection('gui-only-browser'), /no monitorable page/i);
  assert.deepEqual(browserDouble.page('dashboard').viewportSize(), { width: 390, height: 844 });
});
```

Add a small test helper with the same fetch contract used by current hub tests:

```js
function createConnectedMonitorHub(browserDouble, sessionId) {
  return new BrowserMonitorHub({
    pwDevUrl: 'http://pw-dev.test',
    connectOverCDP: async () => browserDouble.browser,
    fetchJson: async () => ({
      ok: true,
      statusCode: 200,
      body: { browser: { runtime: { sessionId, cdpUrl: 'http://broker.test/session' } } },
    }),
  });
}
```

- [ ] **Step 2: Run the focused tests and confirm the red state**

Run:

```bash
node --test --test-name-pattern='monitor excludes known GUI|monitor reports a GUI-only' packages/gui/test/gui.test.js
```

Expected: FAIL because `addGuiOrigin` does not exist and current selection chooses the first page.

- [ ] **Step 3: Implement GUI-origin registration and page filtering in the hub**

Initialize an origin set, normalize origins with `new URL`, and filter descriptors before any automatic selection or fallback:

```js
constructor({ pwDevUrl, connectOverCDP, fetchJson: fetchJsonImpl = fetchJson }) {
  this.pwDevUrl = pwDevUrl;
  this.connectOverCDP = connectOverCDP;
  this.fetchJson = fetchJsonImpl;
  this.guiOrigins = new Set();
  this.connections = new Map();
  this.previewPromises = new Map();
}

addGuiOrigin(origin) {
  try {
    this.guiOrigins.add(new URL(origin).origin);
  } catch {
    // Ignore malformed request-host aliases; the bound origin is registered separately.
  }
}

isGuiPage(page) {
  try {
    return this.guiOrigins.has(new URL(page.url).origin);
  } catch {
    return false;
  }
}

async monitorablePages(browser) {
  return (await this.describePages(browser)).filter((entry) => !this.isGuiPage(entry));
}
```

Use `monitorablePages()` in `ensureConnection()`, `describeSessionPages()`, and `refreshPageInventory()`. Filter remote descriptors with the same `isGuiPage()` predicate before merging lease metadata. Preserve an explicit external `pageId`; reject a GUI `pageId` through the same no-monitorable-page path.

```js
const pages = await this.monitorablePages(browser);
const selected = pageId ? pages.find((entry) => entry.id === pageId) : pages[0];
if (!selected) {
  await browser.close();
  throw httpError(409, 'Browser session has no monitorable page');
}
```

- [ ] **Step 4: Register the real bound origin and request-host aliases in the server**

Add a helper and invoke it before the monitor event, preview, action, and HTML routes:

```js
function registerMonitorGuiOrigin(monitorHub, req) {
  if (!req.headers.host) return;
  monitorHub.addGuiOrigin?.(`http://${req.headers.host}`);
}
```

After `server.listen` determines `actualPort`, register the canonical origin:

```js
const origin = `http://${host}:${actualPort}`;
monitorHub.addGuiOrigin?.(origin);
```

This supports `127.0.0.1`, `localhost`, and configured hostnames without excluding unrelated localhost ports.

- [ ] **Step 5: Run the focused tests and the GUI test file**

Run:

```bash
node --test --test-name-pattern='monitor excludes known GUI|monitor reports a GUI-only|two-tab monitor' packages/gui/test/gui.test.js
npm test --workspace @pw-dev/gui
```

Expected: PASS, including the existing multi-page fallback and 1080p tests.

- [ ] **Step 6: Commit the monitor target-selection fix**

```bash
git add packages/gui/src/monitor.js packages/gui/src/server.js packages/gui/test/gui.test.js
git commit -m "fix(gui): exclude dashboard pages from monitoring"
```

---

### Task 2: Non-throwing dialog ownership

**Files:**
- Modify: `packages/gui/src/monitor.js:324-335`
- Test: `packages/gui/test/gui.test.js:1-32,1443-1541`

**Interfaces:**
- Consumes: Playwright `Page` `dialog` events and `Dialog.dismiss(): Promise<void>`.
- Produces: `observePage(connection, page)` installs exactly one dialog listener per Page through `connection.observedPages` and consumes every dismissal rejection.

- [ ] **Step 1: Add a failing deterministic dialog-race test**

Extend the page double with its existing `EventEmitter` so the test can emit `dialog`, then add:

```js
test('monitor consumes a dialog dismissal race without an unhandled rejection', async () => {
  const browserDouble = createMonitorBrowserDouble([
    { id: 'dialog-page', title: 'Dialog', url: 'https://dialog.test/' },
    { id: 'background-page', title: 'Background', url: 'https://dialog.test/background' },
  ]);
  const hub = createConnectedMonitorHub(browserDouble, 'dialog-session');
  const page = browserDouble.page('dialog-page');
  const rejection = new Error('Protocol error (Page.handleJavaScriptDialog): No dialog is showing');
  let unhandled;
  const onUnhandled = (error) => { unhandled = error; };
  process.once('unhandledRejection', onUnhandled);

  try {
    await hub.ensureConnection('dialog-browser', 'dialog-page');
    hub.observePage(hub.connections.get('dialog-browser:dialog-page'), page);
    assert.equal(page.listenerCount('dialog'), 1);
    assert.equal(browserDouble.page('background-page').listenerCount('dialog'), 1);
    page.emit('dialog', { dismiss: async () => { throw rejection; } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled, undefined);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    await hub.close();
  }
});
```

Expose the existing per-page `EventEmitter` methods on the returned double:

```js
on: events.on.bind(events),
emit: events.emit.bind(events),
listenerCount: events.listenerCount.bind(events),
```

- [ ] **Step 2: Run the dialog test and confirm the red state**

Run:

```bash
node --test --test-name-pattern='dialog dismissal race' packages/gui/test/gui.test.js
```

Expected: FAIL because `observePage()` has no `dialog` listener and the test sees zero listeners.

- [ ] **Step 3: Add an owned, non-throwing dialog listener**

Install the handler within the existing one-page guard:

```js
observePage(connection, page) {
  if (connection.observedPages.has(page)) return;
  connection.observedPages.add(page);
  page.on('dialog', (dialog) => {
    void dialog.dismiss().catch(() => {
      // Another CDP client may have handled the browser-wide dialog first.
    });
  });
  page.on('domcontentloaded', () => void this.refresh(connection));
  page.on('load', () => void this.refresh(connection));
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) void this.refresh(connection);
  });
}
```

After constructing the connection in `ensureConnection()`, observe every page
from the already filtered `pages` array:

```js
for (const entry of pages) this.observePage(connection, entry.page);
```

In `refreshPageInventory()`, call `observePage()` for every entry in
`localPages` before selecting a fallback. This covers background pages and
popups without duplicating listeners.

Do not rethrow or create a detached rejecting promise: dialog races must never reach the process event loop.

- [ ] **Step 4: Add a real two-client Chromium regression**

Add a real two-client Chromium regression. Import `spawn` from
`node:child_process`, `os` from `node:os`, and `path` from `node:path`, then add
a helper that launches the installed Chromium with an ephemeral CDP port:

```js
async function launchCdpBrowser() {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pwdev-gui-dialog-'));
  const child = spawn(chromium.executablePath(), [
    '--headless=new',
    '--no-first-run',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsEndpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Timed out starting Chromium: ${output}`)), 10_000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Chromium exited before CDP was ready: ${code}`)));
  });
  return {
    wsEndpoint,
    async close() {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
      }
      await fs.rm(userDataDir, { recursive: true, force: true });
    },
  };
}
```

Use it to connect the hub and a competing Playwright client to the same real
browser:

```js
test('monitor remains usable when a second CDP client handles a real confirm dialog', async () => {
  const launched = await launchCdpBrowser();
  const competitor = await chromium.connectOverCDP(launched.wsEndpoint);
  const hub = new BrowserMonitorHub({
    pwDevUrl: 'http://pw-dev.test',
    connectOverCDP: (endpoint) => chromium.connectOverCDP(endpoint),
    fetchJson: async () => ({
      ok: true,
      statusCode: 200,
      body: { browser: { runtime: { sessionId: 'real-dialog', cdpUrl: launched.wsEndpoint } } },
    }),
  });
  let unhandled;
  const onUnhandled = (error) => { unhandled = error; };
  process.once('unhandledRejection', onUnhandled);
  try {
    const page = competitor.contexts()[0].pages()[0];
    await page.setContent('<button onclick="confirm(\'continue?\')">Confirm</button>');
    await hub.ensureConnection('real-dialog-browser');
    page.once('dialog', (dialog) => void dialog.accept().catch(() => {}));
    await page.click('button');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled, undefined);
    assert.ok((await hub.preview('real-dialog-browser')).length > 0);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    await hub.close();
    await competitor.close();
    await launched.close();
  }
});
```

If the machine's Chromium does not accept `--headless=new`, use `--headless`
in the helper; do not skip the two-client behavior.

- [ ] **Step 5: Run the dialog and monitor regression tests**

Run:

```bash
node --test --test-name-pattern='dialog|monitor keeps click telemetry|two-tab monitor' packages/gui/test/gui.test.js
npm test --workspace @pw-dev/gui
```

Expected: PASS with one dialog listener per observed page and no unhandled rejection.

- [ ] **Step 6: Commit the dialog fix**

```bash
git add packages/gui/src/monitor.js packages/gui/test/gui.test.js
git commit -m "fix(gui): contain competing browser dialogs"
```

---

### Task 3: Recoverable dashboard refresh and announced state

**Files:**
- Modify: `packages/gui/public/index.html:10-50`
- Modify: `packages/gui/public/app.js:1-165,236-253`
- Modify: `packages/gui/public/styles.css:36-142`
- Test: `packages/gui/test/gui.test.js:430-622`

**Interfaces:**
- Consumes: `/api/config`, `/api/snapshot`, `state.intervalMs`, and the last normalized snapshot.
- Produces: `setRefreshStatus(kind: 'loading'|'ok'|'error', message: string): void`; `performRefresh(): Promise<boolean>` returns success instead of rejecting for snapshot fetch failures.
- Produces: `#refresh-status[role=status][aria-live=polite]`, enabled creation controls after configuration loads, and a timer that always schedules its next attempt.

- [ ] **Step 1: Add a failing Playwright test for initial failure, retry, stale data, and recovery**

Use a 50 ms interval by setting `#interval` from the page before dispatching `change`; route the first snapshot successfully, the second with status 503, and later requests successfully:

```js
test('dashboard keeps stale data visible and resumes polling after a snapshot failure', async () => {
  const browser = await chromium.launch({ headless: true });
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub: { async close() {} } });
  let requests = 0;
  try {
    const page = await browser.newPage();
    await page.route('**/api/config', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, pwDevUrl: 'http://pw-dev.test' }),
    }));
    await page.route('**/api/snapshot', (route) => {
      requests += 1;
      if (requests === 2) return route.fulfill({ status: 503, body: 'snapshot unavailable' });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(browserPreviewSnapshot()) });
    });
    await page.route('**/api/pwdev/sessions/preview-session/pages', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ pages: [] }),
    }));
    await page.goto(gui.origin);
    await page.getByText('Preview browser').waitFor();
    await page.locator('#interval').evaluate((select) => {
      select.append(new Option('test', '50'));
      select.value = '50';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector('#refresh-status')?.dataset.state === 'error');
    assert.equal(await page.getByText('Preview browser').count(), 1);
    await page.waitForFunction(() => document.querySelector('#refresh-status')?.dataset.state === 'ok');
    assert.ok(requests >= 3, 'automatic polling must continue after failure');
    assert.equal(await page.locator('#refresh').isDisabled(), false);
  } finally {
    await browser.close();
    await gui.close();
  }
});
```

Add the initial-failure case with an explicit recovery toggle:

```js
test('dashboard can recover from an initial snapshot failure without reloading', async () => {
  const browser = await chromium.launch({ headless: true });
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub: { async close() {} } });
  let failing = true;
  try {
    const page = await browser.newPage();
    await page.route('**/api/config', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, pwDevUrl: 'http://pw-dev.test' }),
    }));
    await page.route('**/api/snapshot', (route) => failing
      ? route.fulfill({ status: 503, body: 'snapshot unavailable' })
      : route.fulfill({ contentType: 'application/json', body: JSON.stringify(browserPreviewSnapshot()) }));
    await page.route('**/api/pwdev/sessions/preview-session/pages', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ pages: [] }),
    }));
    await page.goto(gui.origin);
    await page.waitForFunction(() => document.querySelector('#refresh-status')?.dataset.state === 'error');
    for (const selector of ['#new-browser', '#new-browser-config', '#new-proxy']) {
      assert.equal(await page.locator(selector).isEnabled(), true);
    }
    failing = false;
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.querySelector('#refresh-status')?.dataset.state === 'ok');
    await page.getByText('Preview browser').waitFor();
  } finally {
    await browser.close();
    await gui.close();
  }
});
```

- [ ] **Step 2: Run the refresh tests and confirm the red state**

Run:

```bash
node --test --test-name-pattern='dashboard keeps stale data|dashboard can recover from an initial snapshot' packages/gui/test/gui.test.js
```

Expected: FAIL because the timer chain stops on rejection, the failure has no visible status, and initial failure prevents controls from enabling.

- [ ] **Step 3: Add semantic refresh status markup and clear copy**

Wrap the existing header and main in `<div id="page-shell">`, keeping the modal
as its sibling, and replace the toolbar markup with:

```html
<div class="toolbar">
  <span id="refresh-status" class="refresh-status" role="status" aria-live="polite" data-state="loading">Loading…</span>
  <label class="inline-field">
    <span>Auto refresh</span>
    <select id="interval">
      <option value="2000">2s</option>
      <option value="5000" selected>5s</option>
      <option value="10000">10s</option>
      <option value="0">Paused</option>
    </select>
  </label>
  <button id="refresh" class="button-primary" type="button">Refresh now</button>
</div>
```

Keep `#markdown-modal` outside `#page-shell` so the shell can become inert in Task 5.

- [ ] **Step 4: Make initialization and polling settle safely**

Add `refreshStatus` to `els`, then implement:

```js
function setRefreshStatus(kind, message) {
  els.refreshStatus.dataset.state = kind;
  els.refreshStatus.textContent = message;
}

async function init() {
  try {
    const config = await fetchJson('/api/config');
    state.pwDevUrl = config.pwDevUrl;
    await refresh();
  } catch (error) {
    setRefreshStatus('error', `Refresh failed: ${error.message}`);
  } finally {
    els.newBrowser.disabled = false;
    els.newBrowserConfig.disabled = false;
    els.newProxy.disabled = false;
    schedule();
  }
}

function schedule() {
  if (state.timer) clearTimeout(state.timer);
  state.timer = undefined;
  if (state.intervalMs <= 0) return;
  state.timer = setTimeout(async () => {
    state.timer = undefined;
    try {
      await refresh();
    } finally {
      schedule();
    }
  }, state.intervalMs);
}
```

Update manual refresh to reset its interval after the request settles:

```js
els.refresh.addEventListener('click', async () => {
  if (state.timer) clearTimeout(state.timer);
  state.timer = undefined;
  await refresh();
  schedule();
});
```

- [ ] **Step 5: Retain useful state and return an explicit refresh result**

```js
async function performRefresh() {
  els.refresh.disabled = true;
  setRefreshStatus('loading', state.last ? 'Refreshing…' : 'Loading…');
  const previous = state.last;
  try {
    const snapshot = normalizeSnapshot(await fetchJson('/api/snapshot'));
    state.last = snapshot;
    await render(snapshot);
    setRefreshStatus('ok', 'Up to date');
    return true;
  } catch (error) {
    state.last = previous;
    setRefreshStatus('error', `Refresh failed: ${error.message}`);
    return false;
  } finally {
    els.refresh.disabled = false;
  }
}
```

Assigning before `render()` preserves the existing preview-cleanup contract;
restoring in the catch path keeps the last successful snapshot authoritative if
rendering fails.

- [ ] **Step 6: Style the compact live status**

```css
.refresh-status { color: #d5dbe1; font-size: 12px; white-space: nowrap; }
.refresh-status[data-state="ok"] { color: #bce7cf; }
.refresh-status[data-state="error"] { color: #ffd0cd; }
```

- [ ] **Step 7: Run refresh tests and commit**

Run:

```bash
node --test --test-name-pattern='dashboard keeps stale data|dashboard can recover from an initial snapshot' packages/gui/test/gui.test.js
npm test --workspace @pw-dev/gui
```

Expected: PASS; request count continues increasing after the forced 503 and both recovery paths clear the error.

```bash
git add packages/gui/public/index.html packages/gui/public/app.js packages/gui/public/styles.css packages/gui/test/gui.test.js
git commit -m "fix(gui): recover dashboard snapshot polling"
```

---

### Task 4: Dashboard-side preview filtering and contextual empty state

**Files:**
- Modify: `packages/gui/public/app.js:696-812,940-990`
- Test: `packages/gui/test/gui.test.js:826-1060`

**Interfaces:**
- Consumes: session page records `{ id, title, url, lease? }` and `location.origin`.
- Produces: `isGuiPage(page): boolean` and `monitorablePreviewPages(pages): PageRecord[]`; preview fetches are made only when a selected external page ID exists.
- Produces: exact empty-state copy `Open a target page to load a preview.` for a running browser with no monitorable page.

- [ ] **Step 1: Add a failing dashboard behavior test**

```js
test('dashboard previews exclude same-origin GUI tabs and never capture without an external page', async () => {
  const browser = await chromium.launch({ headless: true });
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub: { async close() {} } });
  let previewRequests = 0;
  try {
    const seedPage = await browser.newPage({ viewport: { width: 160, height: 90 } });
    await seedPage.setContent('<body style="margin:0;background:#36c"></body>');
    const preview = await seedPage.screenshot({ type: 'jpeg' });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await routeDashboardSnapshot(page, browserPreviewSnapshot());
    await page.route('**/api/pwdev/sessions/preview-session/pages', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ pages: [
        { id: 'dashboard', title: 'pw-dev', url: `${gui.origin}/` },
        { id: 'target', title: 'Target', url: 'http://127.0.0.1:3000/' },
        { id: 'monitor', title: 'Monitor', url: `${gui.origin}/monitor/preview-browser` },
      ] }),
    }));
    await page.route('**/api/monitor/preview-browser/preview*', (route) => {
      previewRequests += 1;
      assert.match(route.request().url(), /pageId=target/);
      return route.fulfill({ contentType: 'image/jpeg', body: preview });
    });
    await page.goto(gui.origin);
    await page.waitForFunction(() => document.querySelectorAll('.browser-preview-dot').length === 0);
    assert.equal(previewRequests, 1);
    assert.doesNotMatch(await page.locator('.browser-preview').textContent(), /pw-dev|Monitor/);
  } finally {
    await browser.close();
    await gui.close();
  }
});
```

Add the GUI-only page variant:

```js
test('dashboard shows a target-page empty state for a GUI-only session', async () => {
  const browser = await chromium.launch({ headless: true });
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub: { async close() {} } });
  let previewRequests = 0;
  try {
    const page = await browser.newPage();
    await routeDashboardSnapshot(page, browserPreviewSnapshot());
    await page.route('**/api/pwdev/sessions/preview-session/pages', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ pages: [
        { id: 'dashboard', title: 'pw-dev', url: `${gui.origin}/` },
        { id: 'monitor', title: 'Monitor', url: `${gui.origin}/monitor/preview-browser` },
      ] }),
    }));
    await page.route('**/api/monitor/preview-browser/preview*', (route) => {
      previewRequests += 1;
      return route.abort();
    });
    await page.goto(gui.origin);
    await page.getByText('Open a target page to load a preview.').waitFor();
    assert.equal(previewRequests, 0);
    assert.equal(await page.locator('.browser-preview-dot').count(), 0);
  } finally {
    await browser.close();
    await gui.close();
  }
});
```

Add this shared routing helper near `browserPreviewSnapshot()`:

```js
async function routeDashboardSnapshot(page, snapshot) {
  await page.route('**/api/config', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      pwDevUrl: 'http://pw-dev.test',
      brokerUrl: 'http://broker.test',
      proxyManagerUrl: 'http://proxy.test',
    }),
  }));
  await page.route('**/api/snapshot', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(snapshot),
  }));
  await page.route('**/api/pwdev/sessions/preview-session/pages', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ pages: [] }),
  }));
}
```

- [ ] **Step 2: Run the preview-filter tests and confirm the red state**

Run:

```bash
node --test --test-name-pattern='dashboard previews exclude|dashboard shows a target-page empty state' packages/gui/test/gui.test.js
```

Expected: FAIL because the dashboard chooses the first same-origin page and calls the preview endpoint.

- [ ] **Step 3: Filter before selection and before capture**

```js
function isGuiPage(page) {
  try {
    return new URL(page.url).origin === location.origin;
  } catch {
    return false;
  }
}

function monitorablePreviewPages(pages) {
  return pages.filter((page) => !isGuiPage(page));
}
```

Inside `refreshBrowserPreviews()`:

```js
const pages = monitorablePreviewPages(Array.isArray(body.pages) ? body.pages : []);
state.previewPages.set(browser.id, pages);
const selectedPageId = state.previewPageIds.get(browser.id);
if (!pages.some((page) => page.id === selectedPageId)) {
  state.previewPageIds.set(browser.id, pages[0]?.id);
}
const pageId = state.previewPageIds.get(browser.id);
if (!pageId) return;
const response = await fetch(
  `/api/monitor/${encodeURIComponent(browser.id)}/preview?pageId=${encodeURIComponent(pageId)}`,
  { cache: 'no-store' },
);
```

When no `pageId` exists, revoke and delete any previous preview URL for that browser so an obsolete external screenshot is not shown as current.

- [ ] **Step 4: Render the contextual state for a running GUI-only browser**

In the existing `else` branch of the browser preview renderer, distinguish
stopped from running-without-target:

```js
preview.classList.add('empty');
const pages = state.previewPages.get(browser.id);
preview.textContent = !browser.sessionId
  ? 'Start the browser to load a preview.'
  : pages && pages.length === 0
    ? 'Open a target page to load a preview.'
    : 'Loading preview…';
```

Keep the monitor button disabled or omitted until a selected page ID exists, preventing an unscoped monitor connection from selecting a GUI page.

- [ ] **Step 5: Run thumbnail and filtering regressions**

Run:

```bash
node --test --test-name-pattern='dashboard previews exclude|target-page empty state|browser thumbnail' packages/gui/test/gui.test.js
```

Expected: PASS, including decode-before-swap and generation-race coverage.

- [ ] **Step 6: Commit the dashboard target filter**

```bash
git add packages/gui/public/app.js packages/gui/test/gui.test.js
git commit -m "fix(gui): prevent recursive dashboard previews"
```

---

### Task 5: Accessible view state and README modal

**Files:**
- Modify: `packages/gui/public/index.html:50-105,206-222`
- Modify: `packages/gui/public/app.js:1-120,175-185,1588-1623`
- Modify: `packages/gui/public/styles.css:121-139,315-331,432-454,488-552`
- Test: `packages/gui/test/gui.test.js:430-622`

**Interfaces:**
- Consumes: `.nav-item`, `[data-browser-view]`, `#page-shell`, and modal invoker elements.
- Produces: exactly one `aria-current="page"` nav button, mutually exclusive `aria-pressed` browser-view buttons, and modal Tab containment.
- Produces: `state.markdownModalInvoker: Element|undefined`, `modalFocusableElements(): HTMLElement[]`, and one `closeMarkdownModal()` path that removes inert state and restores focus.

- [ ] **Step 1: Add failing rendered-state and modal keyboard tests**

```js
test('dashboard exposes active view state and contains README modal focus', async () => {
  const browser = await chromium.launch({ headless: true });
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub: { async close() {} } });
  try {
    const page = await browser.newPage();
    await routeDashboardSnapshot(page, snapshotWithReadme());
    await page.goto(gui.origin);

    const browsersNav = page.locator('.nav-item[data-view="browsers"]');
    assert.equal(await browsersNav.getAttribute('aria-current'), 'page');
    await page.locator('.nav-item[data-view="apps"]').click();
    assert.equal(await browsersNav.getAttribute('aria-current'), null);
    assert.equal(await page.locator('.nav-item[data-view="apps"]').getAttribute('aria-current'), 'page');

    assert.equal(await page.locator('[data-browser-view="diagram"]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-browser-view="table"]').click();
    assert.equal(await page.locator('[data-browser-view="diagram"]').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('[data-browser-view="table"]').getAttribute('aria-pressed'), 'true');

    const invoker = page.getByRole('button', { name: 'View README' }).first();
    await invoker.click();
    assert.equal(await page.locator('#page-shell').getAttribute('inert'), '');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'copy-markdown-modal');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'close-markdown-modal');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'View README');
    assert.equal(await page.locator('#page-shell').getAttribute('inert'), null);
  } finally {
    await browser.close();
    await gui.close();
  }
});
```

Extend the same test with backdrop and Close-button paths:

```js
await invoker.click();
await page.locator('[data-close-markdown-modal]').click({ position: { x: 4, y: 4 } });
assert.equal(await invoker.evaluate((button) => document.activeElement === button), true);
await invoker.click();
await page.locator('#close-markdown-modal').click();
assert.equal(await invoker.evaluate((button) => document.activeElement === button), true);
```

Define the fixture explicitly next to `browserPreviewSnapshot()`:

```js
function snapshotWithReadme() {
  const snapshot = browserPreviewSnapshot();
  snapshot.server.apps.body.apps = [{
    id: 'readme-app',
    name: 'README app',
    appUrl: 'https://readme.test/',
    readme: '# README\n\nKeyboard-accessible content.',
  }];
  return snapshot;
}
```

- [ ] **Step 2: Run the accessibility test and confirm the red state**

Run:

```bash
node --test --test-name-pattern='dashboard exposes active view state' packages/gui/test/gui.test.js
```

Expected: FAIL on missing ARIA attributes, focus escaping to `body`, and absent restoration.

- [ ] **Step 3: Maintain ARIA state from the existing view functions**

Set correct initial attributes in `index.html`, then update them alongside classes:

```js
for (const item of document.querySelectorAll('[data-browser-view]')) {
  const active = item.dataset.browserView === state.browserView;
  item.classList.toggle('active', active);
  item.setAttribute('aria-pressed', String(active));
}

for (const item of document.querySelectorAll('.nav-item')) {
  const active = item.dataset.view === view;
  item.classList.toggle('active', active);
  if (active) item.setAttribute('aria-current', 'page');
  else item.removeAttribute('aria-current');
}
```

On mobile, when `showView()` opens a group, close sibling groups so navigation
remains a predictable accordion:

```js
const activeGroup = navItem?.closest('details.nav-group');
if (activeGroup) activeGroup.open = true;
if (matchMedia('(max-width: 850px)').matches) {
  for (const group of document.querySelectorAll('details.nav-group')) {
    if (group !== activeGroup) group.open = false;
  }
}
```

- [ ] **Step 4: Trap and restore README modal focus**

Add `pageShell` to `els` and `markdownModalInvoker` to state. Pass the click invoker from `createMarkdownViewer()`:

```js
button.addEventListener('click', () => openMarkdownModal(value.title, value.text, button));
```

Implement the shared focus logic:

```js
function modalFocusableElements() {
  return [...els.markdownModal.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.hidden && element.getClientRects().length > 0);
}

function openMarkdownModal(title, text, invoker) {
  state.markdownModalInvoker = invoker;
  state.markdownModalText = text;
  els.markdownModalTitle.textContent = 'README';
  els.markdownModalSubtitle.textContent = title ?? '';
  renderMarkdown(els.markdownModalContent, text);
  els.copyMarkdownModal.textContent = 'Copy README';
  els.markdownModal.classList.remove('hidden');
  els.pageShell.inert = true;
  document.body.classList.add('modal-open');
  els.closeMarkdownModal.focus();
}

function closeMarkdownModal() {
  if (els.markdownModal.classList.contains('hidden')) return;
  els.markdownModal.classList.add('hidden');
  els.pageShell.inert = false;
  document.body.classList.remove('modal-open');
  const invoker = state.markdownModalInvoker;
  state.markdownModalInvoker = undefined;
  if (invoker?.isConnected) invoker.focus();
}
```

In the document keydown handler, prevent default on Tab and wrap first/last focus only while the modal is open; keep Escape routed through `closeMarkdownModal()`.

- [ ] **Step 5: Add consistent focus-visible styling**

```css
:where(button, select, input, textarea, a, summary, [tabindex]):focus-visible {
  outline: 3px solid var(--focus-ring);
  outline-offset: 2px;
}
```

Do not remove component-specific inset focus styles where the outside ring would be clipped.

- [ ] **Step 6: Run the accessibility test, full GUI tests, and commit**

Run:

```bash
node --test --test-name-pattern='dashboard exposes active view state' packages/gui/test/gui.test.js
npm test --workspace @pw-dev/gui
```

Expected: PASS for Tab, Shift+Tab, Escape, backdrop, Close, and focus restoration.

```bash
git add packages/gui/public/index.html packages/gui/public/app.js packages/gui/public/styles.css packages/gui/test/gui.test.js
git commit -m "fix(gui): expose accessible dashboard state"
```

---

### Task 6: Dashboard visual hierarchy, tables, and responsive layout

**Files:**
- Modify: `packages/gui/public/index.html:16-105`
- Modify: `packages/gui/public/app.js:814-838,864-990,999-1570`
- Modify: `packages/gui/public/styles.css:1-18,102-486,555-735,775-940`
- Test: `packages/gui/test/gui.test.js:430-622`

**Interfaces:**
- Consumes: action descriptors returned by `browserActions`, `browserConfigActions`, and `proxyActions`.
- Produces: action descriptors may include `kind: 'primary'|'danger'`; `createActionButtons()` maps that to `.button-primary` or `.button-danger`.
- Produces: auto-fit browser cards, wrapped table cells, discoverable desktop actions, compact 2x2 mobile status, contextual empty copy, and no page-level horizontal overflow at 1440 or 390 CSS pixels.

- [ ] **Step 1: Add failing desktop and mobile layout tests**

Use a snapshot containing one browser and a deliberately long browser-config target URL:

```js
test('dashboard layout is compact and keeps actions reachable at desktop and mobile widths', async () => {
  const browser = await chromium.launch({ headless: true });
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub: { async close() {} } });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const pageErrors = [];
    const failedResponses = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('response', (response) => {
      if (new URL(response.url()).origin === gui.origin && response.status() >= 400) {
        failedResponses.push(`${response.status()} ${response.url()}`);
      }
    });
    await routeDashboardSnapshot(page, longContentSnapshot());
    await page.goto(gui.origin);

    const contentWidth = await page.locator('.content').evaluate((element) => element.getBoundingClientRect().width);
    const cardWidth = await page.locator('.browser-diagram').evaluate((element) => element.getBoundingClientRect().width);
    assert.ok(cardWidth >= contentWidth * 0.9, 'a single browser should use the available content width');
    await page.locator('.nav-item[data-view="browser-configs"]').click();
    const deleteButton = page.getByRole('button', { name: 'Delete' }).first();
    assert.ok((await deleteButton.boundingBox()).x < 1440);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 1440);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.nav-item[data-view="browsers"]').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    const metrics = await page.locator('.metric').all();
    const rows = new Set(await Promise.all(metrics.map(async (metric) => Math.round((await metric.boundingBox()).y))));
    assert.equal(rows.size, 2, 'four metrics should form two compact rows');
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(failedResponses, []);
  } finally {
    await browser.close();
    await gui.close();
  }
});
```

Add these assertions before changing the viewport:

```js
const disabledDelete = page.getByRole('button', { name: /Delete/ }).first();
const disabledStyle = await disabledDelete.evaluate((button) => {
  const style = getComputedStyle(button);
  return { opacity: Number(style.opacity), cursor: style.cursor };
});
assert.ok(disabledStyle.opacity < 1);
assert.equal(disabledStyle.cursor, 'not-allowed');
assert.equal(await disabledDelete.evaluate((button) => button.classList.contains('button-danger')), true);
await page.locator('#new-browser-config').click();
const accent = await page.locator('#browser-config-reset-profile').evaluate((checkbox) => getComputedStyle(checkbox).accentColor);
assert.notEqual(accent, 'auto');
await page.locator('.nav-item[data-view="browsers"]').click();
assert.equal(
  await page.locator('.browser-diagram-title').evaluate((heading) => heading.firstElementChild?.className),
  'browser-diagram-info',
);
```

Define the long-content fixture rather than relying on external data:

```js
function longContentSnapshot() {
  const snapshot = browserPreviewSnapshot();
  snapshot.server.browserConfigs.body.browserConfigs[0].targetUrl =
    'https://example.test/a/very/long/path/that/must/wrap?with=a-long-query-value&and=another-long-value';
  snapshot.server.browserConfigs.body.browserConfigs[0].proxyBypassList = [
    '*.internal.example.test',
    '*.services.example.test',
  ];
  snapshot.server.browsers.body.browsers[0].occupancy = {
    state: 'leased',
    owner: 'another-agent',
    taskId: 'long-running-quality-check',
  };
  return snapshot;
}
```

- [ ] **Step 2: Run the layout test and confirm the red state**

Run:

```bash
node --test --test-name-pattern='dashboard layout is compact' packages/gui/test/gui.test.js
```

Expected: FAIL on half-width single card, table overflow, four mobile metric rows, and unstyled disabled/destructive controls.

- [ ] **Step 3: Complete tokens and button hierarchy**

Add tokens without changing the neutral visual character:

```css
:root {
  --accent: #245b8f;
  --accent-hover: #194b79;
  --focus-ring: rgba(36, 91, 143, .35);
  --radius-sm: 6px;
  --radius-md: 9px;
  --shadow-sm: 0 2px 8px rgba(21, 23, 25, .06);
}

button:disabled { cursor: not-allowed; opacity: .52; }
.button-primary { border-color: var(--accent); background: var(--accent); color: #fff; }
.button-primary:hover:not(:disabled) { border-color: var(--accent-hover); background: var(--accent-hover); }
.button-danger { border-color: #d8a5a1; background: var(--red-bg); color: var(--red); }
.button-danger:hover:not(:disabled) { border-color: var(--red); }
```

Add `kind: 'danger'` to every Delete descriptor and `kind: 'primary'` to New/Save descriptors or their fixed markup. In `createActionButtons()`:

```js
if (action.kind) button.classList.add(`button-${action.kind}`);
```

Apply that same line in the `renderCards()` action loop so table, browser-card,
and ordinary card actions share one descriptor contract.

- [ ] **Step 4: Expand browser cards and restore title-first scan order**

```css
.browsers-diagram {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 560px), 1fr));
  gap: 12px;
}

.browser-diagram-title {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.browser-diagram-controls { margin: 0 0 0 auto; }
```

Change the construction order to:

```js
titleInfo.append(titleGroup, occupancyLabel);
heading.append(titleInfo, controls);
```

At the existing card container breakpoint, let controls wrap below with title information still first in DOM order.

- [ ] **Step 5: Constrain and wrap table content**

```css
.entity-table { width: 100%; min-width: 720px; table-layout: auto; }
.entity-table th,
.entity-table td { white-space: normal; overflow-wrap: anywhere; }
.entity-table td:last-child { min-width: 132px; }
.entity-table .mono { word-break: break-word; }
```

Retain `.table-scroll { overflow-x: auto; }`. For dense tables, set a view-specific minimum width via a class supplied by `renderTable()` rather than `width: max-content`; long URLs wrap inside bounded cells and action columns remain visible at ordinary desktop widths.

- [ ] **Step 6: Apply clearer labels and contextual empty states**

Keep the exact toolbar labels from Task 3. Replace broker index output with:

```js
title.textContent = `Broker ${index + 1}`;
```

Extend the shared render signatures and pass entity-aware empty labels at each
renderer call:

```js
function renderTable(root, columns, rows, {
  rowKeys = [],
  rowKeyAttribute = 'sessionId',
  emptyMessage = 'No records',
} = {}) {
  root.replaceChildren();
  if (!rows.length) {
    root.append(emptyState(emptyMessage));
    return;
  }
}

function renderCards(root, cards, { emptyMessage = 'No records' } = {}) {
  root.replaceChildren();
  if (!cards.length) {
    root.append(emptyState(emptyMessage));
    return;
  }
}
```

These snippets replace only the existing signatures and empty branches; retain
the table/card construction that already follows those branches. Add the exact
option at each existing call site:

```js
}), {
  rowKeys: apps.map((app) => app.id),
  rowKeyAttribute: 'appId',
  emptyMessage: 'No apps',
});
}), {
  rowKeys: browserConfigs.map((browserConfig) => browserConfig.id),
  rowKeyAttribute: 'browserConfigId',
  emptyMessage: 'No browser configs',
});
}), {
  rowKeys: proxies.map((proxy) => proxy.id),
  rowKeyAttribute: 'proxyId',
  emptyMessage: 'No proxies',
});
```

Pass `{ emptyMessage: 'No brokers' }` as the third argument of the current
broker-card render call. Use `No sessions`, `No remote hosts`, and `No SSH
keys` at their existing render calls. Keep `No browsers` in the browser view.

- [ ] **Step 7: Compact the mobile dashboard**

At 850 px and below:

```css
@media (max-width: 850px) {
  main { padding: 12px; }
  .status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
  .metric { min-height: 62px; padding: 10px 12px; }
  .layout { grid-template-columns: 1fr; gap: 12px; }
  .nav { position: static; }
  .section-title { align-items: flex-start; flex-wrap: wrap; }
  .section-actions { flex-wrap: wrap; }
}
```

Keep action labels readable and do not make every button full-width.

- [ ] **Step 8: Run layout, existing GUI, and stylesheet regressions**

Run:

```bash
node --test --test-name-pattern='dashboard layout is compact|gui serves static app|browser thumbnail' packages/gui/test/gui.test.js
npm test --workspace @pw-dev/gui
```

Expected: PASS at 1440 and 390 widths with no document-level horizontal overflow.

- [ ] **Step 9: Commit the dashboard polish**

```bash
git add packages/gui/public/index.html packages/gui/public/app.js packages/gui/public/styles.css packages/gui/test/gui.test.js
git commit -m "feat(gui): refine dashboard visual hierarchy"
```

---

### Task 7: Responsive monitor and static-asset hygiene

**Files:**
- Modify: `packages/gui/public/monitor.html:3-8,16-43`
- Modify: `packages/gui/public/monitor.css:1-199`
- Modify: `packages/gui/public/monitor.js:25-76,124-151`
- Modify: `packages/gui/public/styles.css:679-683`
- Test: `packages/gui/test/gui.test.js:430-824`

**Interfaces:**
- Consumes: the decoded screenshot’s `naturalWidth` and `naturalHeight`.
- Produces: CSS custom property `--mirror-aspect` on `#mirror-frame-wrap`, decode-before-swap monitor images, compact one-row browser controls on phones, and explicit `/favicon.svg` loading.
- Produces: `#monitor-status[role=status][aria-live=polite]` and no unexpected same-origin 4xx/5xx request during monitor load.

- [ ] **Step 1: Add failing mobile geometry and asset tests**

Extend the existing screenshot monitor browser setup and record failed responses:

```js
test('monitor stays compact on mobile and loads all same-origin assets', async () => {
  const browser = await chromium.launch({ headless: true });
  const seedPage = await browser.newPage({ viewport: { width: 160, height: 90 } });
  const preview = await seedPage.screenshot({ type: 'jpeg' });
  const gui = await startPwDevGuiServer({
    port: 0,
    brokerDiscovery: false,
    monitorHub: staticMonitorHub(preview),
  });
  const failures = [];
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('response', (response) => {
      if (new URL(response.url()).origin === gui.origin && response.status() >= 400) failures.push(response.url());
    });
    await page.goto(`${gui.origin}/monitor/mobile-browser?pageId=mobile-page`);
    await page.waitForFunction(() => document.querySelector('#mirror-image')?.naturalWidth > 0);

    const headerHeight = await page.locator('.monitor-topbar').evaluate((element) => element.getBoundingClientRect().height);
    assert.ok(headerHeight < 150, `mobile header should be compact, got ${headerHeight}`);
    const controls = await page.locator('.browser-controls').boundingBox();
    const address = await page.locator('.browser-address').boundingBox();
    assert.ok(Math.abs(controls.y - address.y) < 12, 'navigation and address should share a row');
    const wrap = await page.locator('#mirror-frame-wrap').boundingBox();
    assert.ok(wrap.height < 300, `16:9 mirror should not reserve portrait dead space, got ${wrap.height}`);
    assert.deepEqual(failures, []);
    assert.deepEqual(pageErrors, []);
    assert.equal(await page.locator('#monitor-status').getAttribute('role'), 'status');
    assert.equal(await page.locator('#monitor-status').getAttribute('aria-live'), 'polite');
  } finally {
    await browser.close();
    await gui.close();
  }
});
```

Define the test hub explicitly beside the monitor browser tests:

```js
function staticMonitorHub(preview) {
  return {
    async stream(browserId, pageId, req, res) {
      res.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/event-stream; charset=utf-8',
      });
      res.write(`data: ${JSON.stringify({
        type: 'connected',
        browserId,
        sessionId: 'mobile-session',
        pageId: pageId ?? 'mobile-page',
        pages: [{ id: 'mobile-page', title: 'Mobile target', url: 'https://target.test/' }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: 'page',
        browserId,
        url: 'https://target.test/',
        title: 'Mobile target',
        viewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
        scroll: { x: 0, y: 0 },
      })}\n\n`);
      req.once('close', () => res.end());
    },
    async preview() { return preview; },
    async action() { return { ok: true }; },
    async close() {},
  };
}
```

- [ ] **Step 2: Run the mobile monitor test and confirm the red state**

Run:

```bash
node --test --test-name-pattern='monitor stays compact on mobile' packages/gui/test/gui.test.js
```

Expected: FAIL on the tall brand/header, stacked toolbar, 70vh mirror, and `/favicon.ico` 404.

- [ ] **Step 3: Add favicon and live-status markup**

```html
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
```

```html
<span id="monitor-status" class="status-pill neutral" role="status" aria-live="polite">Connecting</span>
```

- [ ] **Step 4: Decode the next monitor image before swapping**

Use the same no-blank-frame rule already proven for dashboard thumbnails:

```js
async function decodedObjectUrl(blob) {
  const url = URL.createObjectURL(blob);
  const candidate = new Image();
  candidate.src = url;
  try {
    await candidate.decode();
    return { url, width: candidate.naturalWidth, height: candidate.naturalHeight };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
```

In `refreshScreenshot()`, assign `image.src` only after decoding, set `--mirror-aspect` to `${width} / ${height}`, then revoke the prior URL. If capture or decode fails, retain the current screenshot.

- [ ] **Step 5: Replace fixed mobile height with intrinsic aspect sizing**

```css
.mirror-frame-wrap {
  --mirror-aspect: 16 / 9;
  position: relative;
  width: 100%;
  aspect-ratio: var(--mirror-aspect);
  min-height: 240px;
  max-height: calc(100vh - 190px);
}

@media (max-width: 620px) {
  .monitor-brand { flex: 0 1 auto; width: 100%; gap: 4px 8px; }
  .monitor-topbar { align-items: flex-start; }
  .monitor-nav { width: 100%; justify-content: flex-start; flex-wrap: wrap; }
  .browser-toolbar { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; }
  .browser-address { width: auto; min-width: 0; }
  .mirror-frame-wrap { height: auto; min-height: 180px; max-height: 65vh; padding: 8px; }
}
```

Keep the desktop mirror useful by allowing the aspect-sized box to reach the existing viewport-relative maximum.

- [ ] **Step 6: Enlarge selector touch targets without enlarging dots**

Apply this pattern to `.page-dot` in `monitor.css` and
`.browser-preview-dot` in `styles.css`:

```css
.page-dot,
.browser-preview-dot {
  position: relative;
  width: 28px;
  min-height: 28px;
  padding: 0;
  border: 0;
  background: transparent;
}
.page-dot::before,
.browser-preview-dot::before {
  content: '';
  position: absolute;
  inset: 8px;
  border: 2px solid #7b8794;
  border-radius: 50%;
}
.page-dot.selected::before,
.browser-preview-dot.selected::before {
  border-color: var(--blue);
  background: var(--blue);
}
.page-dot.leased::before,
.browser-preview-dot.leased::before {
  box-shadow: 0 0 0 2px #f0b429;
}
```

- [ ] **Step 7: Run all monitor behavior tests and commit**

Run:

```bash
node --test --test-name-pattern='monitor|screenshot' packages/gui/test/gui.test.js
npm test --workspace @pw-dev/gui
```

Expected: PASS for input mapping, navigation, thumbnail decoding, mobile geometry, live state, and static assets.

```bash
git add packages/gui/public/monitor.html packages/gui/public/monitor.css packages/gui/public/monitor.js packages/gui/public/styles.css packages/gui/test/gui.test.js
git commit -m "feat(gui): refine responsive browser monitor"
```

---

### Task 8: Full automated verification and real-environment acceptance

**Files:**
- Modify if a regression is found: the smallest owning file under `packages/gui/`
- Test: `packages/gui/test/gui.test.js`
- Create: `.agent/tasks/gui-quality-pass/artifacts/*.png` (ignored audit artifacts, not committed)

**Interfaces:**
- Consumes: live pw-dev at `http://127.0.0.1:9696`, GUI at `http://127.0.0.1:9797`, broker at `http://127.0.0.1:18080`, and the approved control-plane workflow.
- Produces: a healthy 9797 process, a clean temporary browser lifecycle, preserved `google-local` state, final desktop/mobile screenshots, passing automated suites, and an independent read-only review.

- [ ] **Step 1: Run the repository verification suites**

```bash
npm run check:kb
npm test
npm run test:e2e
git diff --check
```

Expected: knowledge-base check passes; all non-skipped tests pass; all E2E tests pass; `git diff --check` prints no errors.

- [ ] **Step 2: Review the complete diff before touching live state**

```bash
git status --short
git diff c0fa36b..HEAD -- packages/gui docs/superpowers
```

Expected: only planned GUI, test, spec, and plan changes appear. Keep audit screenshots ignored.

- [ ] **Step 3: Verify live service ownership and API contracts**

Use the `pw-dev-control-plane` skill. Read the live OpenAPI documents before mutations, verify health on 9696/9797/18080, list browsers/configs/proxies, and record:

```text
browser: google-local
page id: DF2FBB89F4E6895AA32C0D3DBF6C0D52
expected occupancy: unclaimed
expected URL: the existing Google search for “tompall glaser outlaw country history”
```

Restart only the GUI process on 9797 from this checkout after server-side monitor changes. Leave 9696 and the broker running.

- [ ] **Step 4: Run read-only desktop and mobile visual acceptance**

Open the dashboard and monitor at 1440x1000, 1920x1080, and 390x844. Capture screenshots under `.agent/tasks/gui-quality-pass/artifacts/`. At each size verify:

```text
- no page errors or unexpected failed same-origin requests
- no document-level horizontal overflow
- one browser card uses the content width
- long table values wrap and action buttons stay reachable
- status cards use four desktop columns and a mobile 2x2 grid
- active nav/toggle state is visible and exposed through ARIA
- README modal traps focus and returns it on every close path
- monitor header is compact and the mirror has no large blank portrait region
- back, forward, reload, pointer, keyboard, and refresh remain usable
```

- [ ] **Step 5: Exercise the temporary lifecycle through the GUI**

Following the live OpenAPI and control-plane lease requirements, create uniquely suffixed temporary resources through the rendered GUI:

```text
browser config: gui-quality-config- followed by the decimal value of Date.now()
standalone browser: gui-quality-browser- followed by the same decimal value
target page: a local deterministic page with a confirm-dialog button
```

Start the browser, open its monitor, trigger the confirm dialog while a second cooperative Playwright client handles it, then stop, delete the browser, and delete its config through GUI buttons. Confirm `GET /api/healthz` on 9797 remains successful after the dialog and delete confirmations.

- [ ] **Step 6: Restore and prove the authoritative live state**

Release every lease and remove only the uniquely named temporary resources. Verify through the control plane:

```text
- google-local is the only browser
- google-local-config is the only browser config
- google-local occupancy is unclaimed
- page DF2FBB89F4E6895AA32C0D3DBF6C0D52 is still open
- its URL is restored to the original Google search
- no temporary proxy exists
- 9696, 9797, and 18080 are healthy
```

- [ ] **Step 7: Request independent read-only code review**

Use `superpowers:requesting-code-review` and ask the reviewer to compare `c0fa36b..HEAD` against both the design and this plan, emphasizing dialog-race containment, origin filtering, timer recovery, keyboard focus, responsive overflow, and live-state safety. Resolve every valid finding with its own red-green change and rerun the affected suite.

- [ ] **Step 8: Run final verification after review fixes**

```bash
npm run check:kb
npm test
npm run test:e2e
git diff --check
git status --short
curl -fsS http://127.0.0.1:9696/_pwdev/status
curl -fsS http://127.0.0.1:9797/api/healthz
curl -fsS http://127.0.0.1:18080/_broker/status
```

Expected: every command succeeds, all required tests pass, and only intentional ignored artifacts remain outside committed files.

- [ ] **Step 9: Commit any final review-only corrections**

If Step 7 required changes, commit only the corrected files:

```bash
git add packages/gui
git commit -m "fix(gui): address quality pass review"
```

If no correction was needed, do not create an empty commit.

- [ ] **Step 10: Offer branch integration choices**

Use `superpowers:finishing-a-development-branch`. Keep the branch local unless the user explicitly chooses merge, PR, push, or another integration action.
