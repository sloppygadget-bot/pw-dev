import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../public/monitor.js', import.meta.url), 'utf8');
const flush = () => new Promise(setImmediate);
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class Element {
  constructor() {
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.src = '';
    this.complete = true;
    const classes = new Set();
    this.classList = {
      add: (value) => classes.add(value), remove: (value) => classes.delete(value), contains: (value) => classes.has(value),
      toggle(value, force = !classes.has(value)) { if (force) classes.add(value); else classes.delete(value); return force; },
    };
    const properties = new Map();
    this.style = { setProperty: (key, value) => properties.set(key, value), getPropertyValue: (key) => properties.get(key) };
  }
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) ?? [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }
  emit(type, event = {}) { for (const callback of this.listeners.get(type) ?? []) callback(event); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); if (key === 'src') this.src = ''; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  focus() {}
  releasePointerCapture() {}
}

function fixture(count = 8) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const streams = [];
  class EventSource extends Element {
    constructor(url) { super(); this.url = url; streams.push(this); }
    close() { this.closed = true; }
    message(event) { this.emit('message', { data: JSON.stringify(event) }); }
  }
  const revoked = [];
  let nextUrl = 0;
  class ObjectURL extends URL {
    static createObjectURL() { return `blob:monitor-${++nextUrl}`; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  let href = 'http://localhost:9797/monitor/pengxie?pageId=tab-1';
  let documentLoads = 1;
  const history = [];
  const timers = new Map();
  let nextTimer = 0;
  const requests = [];
  const window = new Element();
  const context = {
    document: { body: new Element(), querySelector: element, createElement: () => new Element(), addEventListener() {} },
    window, URL: ObjectURL, URLSearchParams, EventSource, AbortController,
    location: {
      get href() { return href; }, get pathname() { return new URL(href).pathname; }, get search() { return new URL(href).search; },
      assign(url) { href = String(url); documentLoads += 1; },
    },
    history: {
      pushState(_state, _title, url) { href = String(url); history.push(href); },
      replaceState(_state, _title, url) { href = String(url); },
    },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: () => ++nextTimer, cancelAnimationFrame() {},
    Image: class { naturalWidth = 160; naturalHeight = 90; async decode() {} },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      return { ok: true, blob: async () => ({}), json: async () => ({ ok: true }) };
    },
  };
  runInNewContext(`${script}\nglobalThis.monitor = { state, selectPage, refreshScreenshot, clearTarget, sendAction, getPageId: () => pageId };`, context);
  const pages = Array.from({ length: count }, (_, index) => ({ id: `tab-${index + 1}`, title: `Page ${index + 1}`, url: `https://target.test/${index + 1}` }));
  function connect(id = context.monitor.getPageId(), sessionId = 'session-1', inventory = pages) {
    streams.at(-1).message({ type: 'connected', browserId: 'pengxie', sessionId, pageId: id, pages: inventory });
    streams.at(-1).message({ type: 'page', url: inventory.find((page) => page.id === id)?.url, viewport: { width: 1920, height: 1080 } });
  }
  return {
    context, ...context.monitor, element, pages, streams, revoked, requests, timers, window, history, connect,
    get documentLoads() { return documentLoads; },
    get href() { return href; },
    popTo(id) { href = `http://localhost:9797/monitor/pengxie?pageId=${id}`; window.emit('popstate'); },
  };
}

test('monitor reuses a cached screenshot synchronously and switches without reloading the document', async () => {
  const f = fixture();
  f.connect();
  await flush();
  const first = f.element('#mirror-image').src;
  const original = f.streams[0];
  f.selectPage('tab-2');
  assert.equal(f.documentLoads, 1);
  assert.equal(original.closed, true);
  assert.match(f.streams.at(-1).url, /pageId=tab-2$/);
  assert.equal(f.element('#mirror-image').src, '', 'an uncached tab never shows the other tab screenshot');
  f.connect();
  await flush();
  const second = f.element('#mirror-image').src;
  assert.notEqual(second, first);
  f.selectPage('tab-1');
  assert.equal(f.element('#mirror-image').src, first);
  assert.equal(f.element('#mirror-empty').classList.contains('hidden'), true);
  assert.equal(f.element('#refresh-screenshot').disabled, true, 'cached display waits for target confirmation');
  assert.equal(f.state.hasTarget, false);
  assert.equal(f.state.previewCache.size, 2);
  assert.equal(f.revoked.includes(first), false);
  f.connect();
  await flush();
  assert.notEqual(f.element('#mirror-image').src, first, 'fresh capture replaces the cached frame');
  assert.ok(f.revoked.includes(first));
  assert.equal(f.revoked.includes(second), false);
  assert.equal(f.documentLoads, 1);
  assert.equal(f.timers.size, 1, 'only the selected tab keeps a capture timer');
});

test('monitor ignores messages and errors from streams closed by rapid switching', async () => {
  const f = fixture();
  f.connect();
  await flush();
  const old = f.streams[0];
  f.selectPage('tab-2');
  const middle = f.streams[1];
  f.selectPage('tab-3');
  f.connect();
  await flush();
  const current = f.element('#mirror-image').src;
  old.message({ type: 'no-target' });
  middle.message({ type: 'connected', pageId: 'tab-2', pages: f.pages, sessionId: 'session-1' });
  old.onerror();
  assert.equal(f.getPageId(), 'tab-3');
  assert.equal(f.element('#mirror-image').src, current);
  assert.equal(f.state.hasTarget, true);
  assert.equal(f.streams.filter((stream) => !stream.closed).length, 1);
});

test('a slow monitor decode cannot block or overwrite a newly selected target capture', async () => {
  const f = fixture();
  f.connect();
  await flush();
  const gate = deferred();
  f.context.Image = class { naturalWidth = 160; naturalHeight = 90; decode() { return gate.promise; } };
  const older = f.refreshScreenshot();
  await flush();
  const oldController = f.state.captureController;
  f.selectPage('tab-2');
  assert.equal(oldController.signal.aborted, true);
  f.context.Image = class { naturalWidth = 240; naturalHeight = 180; async decode() {} };
  f.connect();
  await flush();
  const latest = f.element('#mirror-image').src;
  assert.equal(f.element('#mirror-frame-wrap').style.getPropertyValue('--mirror-aspect'), '240 / 180');
  gate.resolve();
  await older;
  assert.equal(f.element('#mirror-image').src, latest);
  assert.equal(f.element('#mirror-frame-wrap').style.getPropertyValue('--mirror-aspect'), '240 / 180');
  assert.equal(f.timers.size, 1);
  assert.ok(f.revoked.includes('blob:monitor-2'), 'late decoded object URL is released');
});

test('monitor cache evicts old full-size screenshots after six recently viewed tabs', async () => {
  const f = fixture();
  f.connect();
  await flush();
  const first = f.element('#mirror-image').src;
  for (let index = 2; index <= 7; index += 1) {
    f.selectPage(`tab-${index}`);
    f.connect();
    await flush();
  }
  assert.equal(f.state.previewCache.size, 6);
  assert.equal(f.state.previewCache.has('tab-1'), false);
  assert.ok(f.revoked.includes(first));
  assert.equal(f.revoked.includes(f.element('#mirror-image').src), false);
});

test('monitor drops screenshots for closed or navigated tabs and for a new browser session', async () => {
  const f = fixture();
  f.connect();
  await flush();
  const first = f.element('#mirror-image').src;
  f.selectPage('tab-2');
  f.connect();
  await flush();
  const second = f.element('#mirror-image').src;
  const inventory = [{ ...f.pages[0], url: 'https://changed.test/' }, ...f.pages.slice(2)];
  f.streams.at(-1).message({ type: 'pages', pageId: 'tab-3', pages: inventory });
  assert.ok(f.revoked.includes(first));
  assert.ok(f.revoked.includes(second));
  assert.equal(f.state.previewCache.size, 0);
  assert.equal(f.getPageId(), 'tab-3', 'server fallback switches the target in place');
  f.connect('tab-3', 'session-1', inventory);
  await flush();
  const third = f.element('#mirror-image').src;
  f.connect('tab-3', 'session-2', inventory);
  assert.equal(f.element('#mirror-image').src, '', 'a new session does not display a cached old session frame');
  await flush();
  assert.ok(f.revoked.includes(third));
});

test('monitor history switches reuse cache and preserve one active event stream', async () => {
  const f = fixture();
  f.connect();
  await flush();
  const first = f.element('#mirror-image').src;
  f.selectPage('tab-2');
  f.connect();
  await flush();
  f.popTo('tab-1');
  assert.equal(f.getPageId(), 'tab-1');
  assert.equal(f.element('#mirror-image').src, first);
  assert.equal(f.history.length, 1, 'popstate does not push another history entry');
  assert.equal(f.documentLoads, 1);
  assert.equal(f.streams.filter((stream) => !stream.closed).length, 1);
});

test('monitor blocks cached-frame input until confirmation and releases held input on the old target', async () => {
  const f = fixture();
  f.connect();
  await flush();
  f.state.pressedKeys.add('Control');
  f.state.activePointer = { pointerId: 1, button: 'left', point: { x: 40, y: 20 } };
  f.selectPage('tab-2');
  const releases = f.requests.filter((request) => request.options.keepalive);
  assert.equal(releases.length, 2);
  assert.ok(releases.every((request) => request.url.endsWith('action?pageId=tab-1')));
  assert.deepEqual(releases.map((request) => JSON.parse(request.options.body).type), ['up', 'up']);
  const count = f.requests.length;
  f.sendAction({ action: 'keyboard', type: 'down', key: 'a' });
  assert.equal(f.requests.length, count);
  f.connect();
  await flush();
  f.sendAction({ action: 'keyboard', type: 'down', key: 'b' });
  await flush();
  assert.match(f.requests.at(-1).url, /action\?pageId=tab-2$/);
});

test('monitor unload and terminal no-target release cache, streams, and timers', async () => {
  for (const reason of ['beforeunload', 'no-target']) {
    const f = fixture();
    f.connect();
    await flush();
    f.selectPage('tab-2');
    f.connect();
    await flush();
    const cachedUrls = Array.from(f.state.previewCache.values(), (entry) => entry.url);
    if (reason === 'beforeunload') f.window.emit(reason);
    else f.streams.at(-1).message({ type: reason });
    assert.equal(f.state.previewCache.size, 0);
    assert.equal(f.timers.size, 0);
    assert.ok(cachedUrls.every((url) => f.revoked.includes(url)));
    assert.equal(f.streams.filter((stream) => !stream.closed).length, 0);
  }
});

test('monitor retains the matching cached frame when its fresh capture fails', async () => {
  const f = fixture();
  f.connect();
  await flush();
  const first = f.element('#mirror-image').src;
  f.selectPage('tab-2');
  f.connect();
  await flush();
  f.selectPage('tab-1');
  f.context.fetch = async () => ({ ok: false, status: 503 });
  f.connect();
  await flush();
  assert.equal(f.element('#mirror-image').src, first);
  assert.equal(f.element('#mirror-empty').classList.contains('hidden'), true);
  assert.equal(f.timers.size, 1, 'failed captures continue polling');
});
