import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

// Exercise the real dashboard functions without requiring a browser or sockets.
// Browser layout, keyboard input, and hit targets are covered in gui.test.js.
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const functionSource = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const code = [
  functionSource('function openBrowserMonitor(', 'function isGuiPage('),
  functionSource('function clearBrowserPreviewCache(', 'function refreshVisibleBrowserPreviews('),
  functionSource('async function selectBrowserPreviewPage(', 'function actionGroup('),
].join('\n');

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.disabled = false;
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  click() {
    if (this.disabled) return;
    const event = { stopped: false, stopPropagation() { this.stopped = true; } };
    this.listeners.click(event);
    assert.equal(event.stopped, true, 'tab controls consume clicks');
  }
}

function fixture(count = 12) {
  const browser = { id: 'pengxie', sessionId: 'pengxie-session' };
  const pages = Array.from({ length: count }, (_, index) => ({
    id: `tab-${index + 1}`, title: `Page ${index + 1}`, url: `https://example.test/${index + 1}`,
  }));
  const state = { last: { browsers: [browser] }, nextPreviewRefreshGeneration: 0, previewRefreshCycle: 1 };
  for (const key of ['previewUrls', 'previewTabCache', 'previewPages', 'previewPageIds', 'previewTabOffsets', 'previewRefreshGenerations', 'previewTransitionUrls', 'previewFetchedCycles']) {
    state[key] = new Map();
  }
  state.previewPages.set(browser.id, pages);
  state.previewPageIds.set(browser.id, pages[0]?.id);
  const requests = [];
  const opens = [];
  const pending = [];
  const revoked = [];
  let nextImage = 0;
  let rendered;
  const context = {
    state, document: { createElement: (tag) => new Element(tag) },
    window: { open: (...args) => opens.push(args) },
    URL: { revokeObjectURL: (url) => revoked.push(url) },
    monitorablePreviewPages: (pages) => pages,
    createDecodedImageUrl: async () => `blob:preview-${++nextImage}`,
    fetch: async (url) => {
      requests.push(url);
      return { ok: true, json: async () => ({ pages: state.previewPages.get(browser.id) }), blob: async () => ({}) };
    },
    renderBrowsers: () => { rendered = context.renderBrowserPreviewTabs(browser); },
  };
  runInNewContext(`${code}\nObject.assign(globalThis, { renderBrowserPreviewTabs, selectBrowserPreviewPage, refreshBrowserPreviews, openBrowserMonitor });`, context);
  // Track async click work so assertions run after the actual refresh completes.
  const select = context.selectBrowserPreviewPage;
  context.selectBrowserPreviewPage = (...args) => {
    const promise = select(...args);
    pending.push(promise);
    return promise;
  };
  return {
    browser, pages, state, requests, opens, pending, revoked, context,
    render: () => context.renderBrowserPreviewTabs(browser),
    get rendered() { return rendered; },
  };
}

function controls(root, numberClass = 'browser-preview-tab-numbers') {
  return {
    previous: root.children.find((child) => child.attributes['aria-label'] === 'Previous tabs'),
    next: root.children.find((child) => child.attributes['aria-label'] === 'Next tabs'),
    numbers: root.children.find((child) => child.className === numberClass).children,
  };
}

test('thumbnail numbers expose titles, URLs, selection, and leases as plain text', () => {
  const f = fixture(3);
  f.pages[0].title = '<img src=x onerror=alert(1)>';
  f.pages[0].lease = { owner: 'test-agent' };
  f.pages[1].title = '';
  const root = f.render();
  const { numbers, previous, next } = controls(root);
  assert.deepEqual(numbers.map((button) => button.textContent), ['1', '2', '3']);
  assert.equal(previous, undefined);
  assert.equal(next, undefined);
  assert.equal(numbers[0].title, '<img src=x onerror=alert(1)>\nhttps://example.test/1\nLeased by test-agent');
  assert.equal(numbers[0].attributes['aria-pressed'], 'true');
  assert.equal(numbers[1].attributes['aria-pressed'], 'false');
  assert.match(numbers[0].className, /selected leased/);
  assert.equal(numbers[0].children.length, 0);
  assert.equal(numbers[1].title, '(untitled)\nhttps://example.test/2');
});

test('thumbnail arrows reach every number without changing selection or making network requests', () => {
  const f = fixture();
  const root = f.render();
  assert.equal(controls(root).previous.disabled, true);
  for (let offset = 1; offset <= 9; offset += 1) {
    controls(root).next.click();
    assert.deepEqual(controls(root).numbers.map((button) => button.textContent), [offset + 1, offset + 2, offset + 3].map(String));
  }
  assert.equal(controls(root).next.disabled, true);
  controls(root).next.click();
  assert.deepEqual(controls(root).numbers.map((button) => button.textContent), ['10', '11', '12']);
  for (let offset = 8; offset >= 0; offset -= 1) controls(root).previous.click();
  assert.equal(controls(root).previous.disabled, true);
  assert.equal(f.state.previewPageIds.get(f.browser.id), 'tab-1');
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.opens, []);
});

test('selecting a numbered tab sends its exact ID to the thumbnail and monitor', async () => {
  const f = fixture();
  const root = f.render();
  for (let index = 0; index < 9; index += 1) controls(root).next.click();
  controls(root).numbers[2].click();
  await Promise.all(f.pending);
  assert.equal(f.state.previewPageIds.get(f.browser.id), 'tab-12');
  assert.deepEqual(f.requests, ['/api/pwdev/sessions/pengxie-session/pages', '/api/monitor/pengxie/thumbnail?pageId=tab-12']);
  assert.equal(controls(f.rendered).numbers[2].attributes['aria-pressed'], 'true');
  f.context.openBrowserMonitor(f.browser);
  assert.equal(f.opens[0][0], '/monitor/pengxie?pageId=tab-12');
  assert.deepEqual(controls(f.render()).numbers.map((button) => button.textContent), ['10', '11', '12']);
  const captures = f.requests.length;
  controls(f.rendered).numbers[2].click();
  await Promise.all(f.pending);
  assert.equal(f.requests.length, captures, 'reselecting a tab does not capture again');
});

test('thumbnail number windows persist independently per browser and clamp when tabs close', () => {
  const f = fixture();
  const root = f.render();
  for (let index = 0; index < 9; index += 1) controls(root).next.click();
  assert.deepEqual(controls(f.render()).numbers.map((button) => button.textContent), ['10', '11', '12']);
  const other = { id: 'other' };
  f.state.previewPages.set(other.id, f.pages);
  f.state.previewPageIds.set(other.id, 'tab-1');
  assert.deepEqual(controls(f.context.renderBrowserPreviewTabs(other)).numbers.map((button) => button.textContent), ['1', '2', '3']);
  f.state.previewPages.set(f.browser.id, f.pages.slice(0, 4));
  assert.deepEqual(controls(f.render()).numbers.map((button) => button.textContent), ['2', '3', '4']);
  assert.equal(f.state.previewTabOffsets.get(f.browser.id), 1);
  for (const count of [3, 2, 1, 0]) {
    f.state.previewPages.set(f.browser.id, f.pages.slice(0, count));
    const tabs = f.render();
    if (count < 2) assert.equal(tabs, undefined);
    else {
      assert.equal(controls(tabs).next, undefined);
      assert.deepEqual(controls(tabs).numbers.map((button) => button.textContent), Array.from({ length: count }, (_, index) => String(index + 1)));
    }
  }
});

test('closing the selected thumbnail tab resets the selection and sliding window on refresh', async () => {
  const f = fixture();
  f.state.previewPageIds.set(f.browser.id, 'tab-12');
  f.state.previewTabOffsets.set(f.browser.id, 9);
  f.state.previewPages.set(f.browser.id, f.pages.slice(0, 4));
  await f.context.refreshBrowserPreviews([f.browser]);
  assert.equal(f.state.previewPageIds.get(f.browser.id), 'tab-1');
  assert.deepEqual(controls(f.render()).numbers.map((button) => button.textContent), ['1', '2', '3']);
  assert.equal(f.requests.at(-1), '/api/monitor/pengxie/thumbnail?pageId=tab-1');
});

test('stopping a browser releases its thumbnail number window and preview state', async () => {
  const f = fixture();
  f.state.previewTabOffsets.set(f.browser.id, 9);
  f.state.previewUrls.set(f.browser.id, 'blob:old');
  delete f.browser.sessionId;
  await f.context.refreshBrowserPreviews([]);
  assert.equal(f.state.previewTabOffsets.size, 0);
  assert.equal(f.state.previewPages.size, 0);
  assert.equal(f.state.previewPageIds.size, 0);
  assert.equal(f.state.previewUrls.size, 0);
  assert.deepEqual(f.revoked, ['blob:old']);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('cached thumbnail switches immediately before the tab inventory or capture responds', async () => {
  const f = fixture(3);
  await f.context.refreshBrowserPreviews([f.browser]);
  const first = f.state.previewUrls.get(f.browser.id);
  await f.context.selectBrowserPreviewPage(f.browser, 'tab-2');
  const second = f.state.previewUrls.get(f.browser.id);
  assert.equal(f.revoked.includes(first), false, 'switching retains the first tab screenshot');
  const gate = deferred();
  const fetch = f.context.fetch;
  f.context.fetch = async (url) => { await gate.promise; return fetch(url); };
  const selection = f.context.selectBrowserPreviewPage(f.browser, 'tab-1');
  assert.equal(f.state.previewUrls.get(f.browser.id), first, 'cached screenshot is visible synchronously');
  assert.equal(f.state.previewFetchedCycles.get(f.browser.id), f.state.previewRefreshCycle, 'the new card observer does not duplicate this capture');
  assert.equal(controls(f.rendered).numbers[0].attributes['aria-pressed'], 'true');
  f.context.openBrowserMonitor(f.browser);
  assert.match(f.opens.at(-1)[0], /pageId=tab-1$/);
  gate.resolve();
  await selection;
  assert.notEqual(f.state.previewUrls.get(f.browser.id), first, 'background capture replaces the cached image');
  assert.ok(f.revoked.includes(first), 'replaced screenshot is released');
  assert.equal(f.revoked.includes(second), false, 'other cached tabs stay available');
});

test('an uncached tab selects immediately without showing the previous tab screenshot', async () => {
  const f = fixture(2);
  await f.context.refreshBrowserPreviews([f.browser]);
  const first = f.state.previewUrls.get(f.browser.id);
  const gate = deferred();
  f.context.fetch = async () => { await gate.promise; return { ok: false }; };
  const selection = f.context.selectBrowserPreviewPage(f.browser, 'tab-2');
  assert.equal(f.state.previewUrls.has(f.browser.id), false);
  assert.equal(controls(f.rendered).numbers[1].attributes['aria-pressed'], 'true');
  assert.equal(f.revoked.includes(first), false);
  gate.resolve();
  await selection;
  const back = f.context.selectBrowserPreviewPage(f.browser, 'tab-1');
  assert.equal(f.state.previewUrls.get(f.browser.id), first);
  await back;
  assert.equal(f.state.previewUrls.get(f.browser.id), first, 'failed refresh retains the matching cached screenshot');
});

test('rapid thumbnail switching discards a late decode from a different tab', async () => {
  const f = fixture(2);
  await f.context.refreshBrowserPreviews([f.browser]);
  const decode = f.context.createDecodedImageUrl;
  const started = deferred();
  const gate = deferred();
  let lateUrl;
  f.context.createDecodedImageUrl = async () => {
    lateUrl = await decode();
    started.resolve();
    await gate.promise;
    return lateUrl;
  };
  const older = f.context.selectBrowserPreviewPage(f.browser, 'tab-2');
  await started.promise;
  f.context.createDecodedImageUrl = decode;
  await f.context.selectBrowserPreviewPage(f.browser, 'tab-1');
  const current = f.state.previewUrls.get(f.browser.id);
  gate.resolve();
  await older;
  assert.equal(f.state.previewUrls.get(f.browser.id), current);
  assert.equal(f.state.previewPageIds.get(f.browser.id), 'tab-1');
  assert.equal(f.state.previewTabCache.get(f.browser.id).pages.has('tab-2'), false);
  assert.ok(f.revoked.includes(lateUrl));
});

test('thumbnail cache evicts least recently used tabs after twelve entries', async () => {
  const f = fixture(14);
  await f.context.refreshBrowserPreviews([f.browser]);
  for (let index = 2; index <= 12; index += 1) await f.context.selectBrowserPreviewPage(f.browser, `tab-${index}`);
  const cache = f.state.previewTabCache.get(f.browser.id).pages;
  const second = cache.get('tab-2').url;
  await f.context.selectBrowserPreviewPage(f.browser, 'tab-1');
  await f.context.selectBrowserPreviewPage(f.browser, 'tab-13');
  assert.equal(cache.size, 12);
  assert.equal(cache.has('tab-1'), true, 'a recently revisited tab is retained');
  assert.equal(cache.has('tab-2'), false);
  assert.ok(f.revoked.includes(second));
  assert.equal(f.revoked.includes(f.state.previewUrls.get(f.browser.id)), false, 'the displayed screenshot remains valid');
});

test('thumbnail cache releases closed and navigated tabs while retaining valid screenshots', async () => {
  const f = fixture(3);
  await f.context.refreshBrowserPreviews([f.browser]);
  await f.context.selectBrowserPreviewPage(f.browser, 'tab-2');
  await f.context.selectBrowserPreviewPage(f.browser, 'tab-3');
  const cache = f.state.previewTabCache.get(f.browser.id).pages;
  const first = cache.get('tab-1').url;
  const second = cache.get('tab-2').url;
  const third = cache.get('tab-3').url;
  f.state.previewPages.set(f.browser.id, [{ ...f.pages[0], url: 'https://new.test/' }, f.pages[2]]);
  await f.context.refreshBrowserPreviews([f.browser]);
  assert.equal(cache.has('tab-1'), false);
  assert.equal(cache.has('tab-2'), false);
  assert.ok(f.revoked.includes(first) && f.revoked.includes(second) && f.revoked.includes(third));
  assert.equal(cache.size, 1);
  assert.equal(f.revoked.includes(cache.get('tab-3').url), false);
});

test('a new browser session clears all cached screenshots before its first capture', async () => {
  const f = fixture(2);
  await f.context.refreshBrowserPreviews([f.browser]);
  await f.context.selectBrowserPreviewPage(f.browser, 'tab-2');
  const previous = [...f.state.previewTabCache.get(f.browser.id).pages.values()].map((entry) => entry.url);
  f.browser.sessionId = 'new-session';
  const gate = deferred();
  f.context.fetch = async () => { await gate.promise; return { ok: false }; };
  const refresh = f.context.refreshBrowserPreviews([f.browser]);
  assert.equal(f.state.previewUrls.has(f.browser.id), false);
  assert.equal(f.state.previewTabCache.get(f.browser.id).pages.size, 0);
  assert.ok(previous.every((url) => f.revoked.includes(url)));
  gate.resolve();
  await refresh;
});

test('stopping a browser releases every cached tab screenshot exactly once', async () => {
  const f = fixture(2);
  await f.context.refreshBrowserPreviews([f.browser]);
  await f.context.selectBrowserPreviewPage(f.browser, 'tab-2');
  const cachedUrls = [...f.state.previewTabCache.get(f.browser.id).pages.values()].map((entry) => entry.url);
  delete f.browser.sessionId;
  await f.context.refreshBrowserPreviews([]);
  assert.equal(f.state.previewTabCache.size, 0);
  assert.equal(f.state.previewUrls.size, 0);
  assert.deepEqual(f.revoked.sort(), cachedUrls.sort());
  await f.context.refreshBrowserPreviews([]);
  assert.equal(f.revoked.length, cachedUrls.length);
});

test('a decoded thumbnail cannot restore the cache after its browser stops', async () => {
  const f = fixture(2);
  const gate = deferred();
  const started = deferred();
  f.context.createDecodedImageUrl = async () => {
    started.resolve();
    await gate.promise;
    return 'blob:stopped-preview';
  };
  const capture = f.context.refreshBrowserPreviews([f.browser]);
  await started.promise;
  delete f.browser.sessionId;
  await f.context.refreshBrowserPreviews([]);
  gate.resolve();
  await capture;
  assert.equal(f.state.previewTabCache.size, 0);
  assert.equal(f.state.previewUrls.size, 0);
  assert.ok(f.revoked.includes('blob:stopped-preview'));
});

const monitorSource = readFileSync(new URL('../public/monitor.js', import.meta.url), 'utf8');
function monitorFixture(count = 12) {
  const pages = Array.from({ length: count }, (_, index) => ({
    id: `tab-${index + 1}`, title: `Page ${index + 1}`, url: `https://example.test/${index + 1}`,
  }));
  const assignments = [];
  const context = {
    state: { pageTabOffset: 0 }, pageTabs: new Element('div'), pageSummary: new Element('div'),
    document: { createElement: (tag) => new Element(tag) }, URL,
    selectPage: (id) => assignments.push(`http://localhost:9797/monitor/pengxie?pageId=${id}`),
  };
  runInNewContext(monitorSource.slice(monitorSource.indexOf('function renderPageTabs('), monitorSource.indexOf('function selectPage(')), context);
  return { ...context, pages, assignments, render: (selected = 'tab-1', inventory = pages) => context.renderPageTabs(inventory, selected) };
}

test('monitor tab numbers slide without navigation and keep their window across inventory updates', () => {
  const f = monitorFixture();
  f.render();
  const buttons = () => controls(f.pageTabs, 'page-tab-numbers');
  assert.deepEqual(buttons().numbers.map((button) => button.textContent), ['1', '2', '3']);
  assert.equal(buttons().previous.disabled, true);
  for (let index = 0; index < 9; index += 1) buttons().next.click();
  assert.deepEqual(buttons().numbers.map((button) => button.textContent), ['10', '11', '12']);
  assert.equal(buttons().next.disabled, true);
  f.render();
  assert.deepEqual(buttons().numbers.map((button) => button.textContent), ['10', '11', '12']);
  assert.deepEqual(f.assignments, []);
  buttons().numbers[2].click();
  assert.equal(new URL(f.assignments[0]).searchParams.get('pageId'), 'tab-12');
  buttons().previous.click();
  assert.deepEqual(buttons().numbers.map((button) => button.textContent), ['9', '10', '11']);
});

test('monitor initially reveals the selected tab and updates number, tooltip, and lease state', () => {
  const f = monitorFixture();
  f.pages[11].lease = { owner: 'test-agent' };
  f.render('tab-12');
  const { numbers } = controls(f.pageTabs, 'page-tab-numbers');
  assert.deepEqual(numbers.map((button) => button.textContent), ['10', '11', '12']);
  assert.equal(numbers[2].attributes['aria-pressed'], 'true');
  assert.match(numbers[2].className, /selected leased/);
  assert.equal(numbers[2].title, 'Page 12\nhttps://example.test/12\nLeased by test-agent');
  numbers[2].click();
  assert.deepEqual(f.assignments, [], 'the current tab does not reload when selected again');
  f.render('tab-1', f.pages.slice(0, 4));
  assert.deepEqual(controls(f.pageTabs, 'page-tab-numbers').numbers.map((button) => button.textContent), ['1', '2', '3']);
  assert.match(f.pageSummary.textContent, /Page 1/);
});

test('monitor tab numbers handle short and empty inventories without arrows or stale controls', () => {
  const f = monitorFixture();
  f.render('tab-12');
  for (const count of [3, 2, 1]) {
    f.render('tab-1', f.pages.slice(0, count));
    const { numbers, previous, next } = controls(f.pageTabs, 'page-tab-numbers');
    assert.deepEqual(numbers.map((button) => button.textContent), Array.from({ length: count }, (_, index) => String(index + 1)));
    assert.equal(previous, undefined);
    assert.equal(next, undefined);
  }
  f.render(undefined, []);
  assert.equal(f.pageTabs.children.length, 0);
  assert.equal(f.pageSummary.textContent, 'No open tabs');
});
