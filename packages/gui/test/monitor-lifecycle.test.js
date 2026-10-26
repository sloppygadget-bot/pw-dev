import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { BrowserMonitorHub } from '../src/monitor.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function gate() {
  let release;
  return { promise: new Promise((resolve) => { release = resolve; }), release: () => release() };
}

function fixture({ failAt, connectGate, captureGate } = {}) {
  const clients = [];
  const active = new Set();
  const hub = new BrowserMonitorHub({
    pwDevUrl: 'http://fixture.test',
    fetchJson: async (url) => {
      if (url.endsWith('/pages')) {
        if (failAt === 'inventory') throw new Error('Inventory failed');
        return { ok: true, body: { pages: clients.at(-1).pages.filter((page) => !page.isClosed()).map((page) => ({ id: page.id, url: page.url() })) } };
      }
      return { ok: true, body: { browser: { runtime: { sessionId: 'fixture', cdpUrl: 'http://fixture.test/cdp' } } } };
    },
    connectOverCDP: async () => {
      if (connectGate) await connectGate.promise;
      const events = new EventEmitter();
      const context = new EventEmitter();
      const pages = ['page-a', 'page-b'].map((id) => {
        const page = new EventEmitter();
        let closed = false;
        Object.assign(page, {
          id,
          context: () => context,
          isClosed: () => closed,
          closeTarget: () => { closed = true; },
          url: () => `https://fixture.test/${id}`,
          title: async () => id,
          viewportSize: () => {
            if (failAt === 'viewport') throw new Error('Viewport failed');
            return { width: 1920, height: 1080 };
          },
          exposeFunction: async () => {},
          evaluate: async () => ({ url: page.url(), title: id, viewport: { width: 1920, height: 1080 } }),
          screenshot: async () => {
            if (failAt === 'capture') throw new Error('Capture failed');
            return Buffer.from(id);
          },
        });
        return page;
      });
      let cdpAttached = 0;
      let cdpDetached = 0;
      context.pages = () => pages.filter((page) => !page.isClosed());
      context.newCDPSession = async (page) => {
        cdpAttached++;
        return {
          send: async (method) => {
            if (method === 'Target.getTargetInfo') {
              if (failAt === 'describe') throw new Error('Target closed during initialization');
              return { targetInfo: { targetId: page.id } };
            }
            if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1920, clientHeight: 1080 } };
            assert.equal(method, 'Page.captureScreenshot');
            if (captureGate) await captureGate.promise;
            if (failAt === 'capture') throw new Error('Capture failed');
            return { data: Buffer.from(page.id).toString('base64') };
          },
          detach: async () => { cdpDetached++; },
        };
      };
      let connected = true;
      const browser = Object.assign(events, {
        contexts: () => [context],
        isConnected: () => connected,
        close: async () => {
          if (!connected) return;
          connected = false;
          active.delete(browser);
          events.emit('disconnected');
        },
      });
      clients.push({ browser, pages, get cdpAttached() { return cdpAttached; }, get cdpDetached() { return cdpDetached; } });
      active.add(browser);
      return browser;
    },
  });
  return { hub, clients, active, async cleanup() { await hub.close(); await Promise.all([...active].map((browser) => browser.close())); } };
}

class Response extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableNeedDrain = false;
  writes = 0;
  writeHead() {}
  write() { this.writes++; return !this.writableNeedDrain; }
  end() { this.writableEnded = true; this.emit('finish'); }
}

function assertReleased(f) {
  assert.equal(f.active.size, 0, 'every client must be closed');
  assert.equal(f.hub.connections.size, 0);
  assert.equal(f.hub.ownedConnections.size, 0);
  assert.equal(f.hub.connectionPromises.size, 0);
  assert.ok(f.clients.every((client) => client.cdpAttached === client.cdpDetached), 'temporary CDP sessions must be detached');
}

for (const order of [[undefined, 'page-a'], ['page-a', undefined]]) {
  test(`connection setup coalesces default/explicit aliases: ${order.join(',')}`, async () => {
    const f = fixture();
    try {
      const [a, b] = await Promise.all(order.map((pageId) => f.hub.ensureConnection('browser', pageId)));
      assert.ok(a === b, 'default and explicit aliases must share one client');
      assert.equal(f.clients.length, 1);
      await f.hub.close();
      assertReleased(f);
    } finally { await f.cleanup(); }
  });
}

test('100 overlapping thumbnail/preview rounds leave no orphan clients', async () => {
  for (let i = 0; i < 100; i++) {
    const f = fixture();
    try {
      await Promise.all([f.hub.thumbnail('browser', 'page-a'), f.hub.preview('browser', 'page-a')]);
      assert.equal(f.clients.length, 1);
      await f.hub.close();
      assertReleased(f);
    } finally { await f.cleanup(); }
  }
});

for (const failAt of ['describe', 'viewport']) {
  test(`100 ${failAt} initialization failures close every newly opened client`, async () => {
    const f = fixture({ failAt });
    try {
      for (let i = 0; i < 100; i++) {
        await assert.rejects(f.hub.ensureConnection('browser', 'page-a'));
        assertReleased(f);
      }
      assert.equal(f.clients.length, 100);
    } finally { await f.cleanup(); }
  });
}

test('successful and failed thumbnail/preview requests all expire when idle', async () => {
  const fixtures = [];
  try {
    for (const failAt of [undefined, 'capture']) {
      for (const method of ['thumbnail', 'preview']) {
        const f = fixture({ failAt });
        fixtures.push(f);
        const result = f.hub[method]('browser', 'page-a');
        if (failAt) await assert.rejects(result, /Capture failed/);
        else await result;
        assert.equal(f.active.size, 1);
      }
    }
    await delay(5300);
    for (const f of fixtures) assertReleased(f);
  } finally { await Promise.all(fixtures.map((f) => f.cleanup())); }
});

test('a pending thumbnail keeps its client alive after another capture finishes', async () => {
  const captureGate = gate();
  const f = fixture({ captureGate });
  let pending;
  try {
    pending = f.hub.thumbnail('browser', 'page-a');
    await f.hub.preview('browser', 'page-a');
    await delay(5300);
    assert.equal(f.active.size, 1);
    captureGate.release();
    await pending;
    await f.hub.close();
    assertReleased(f);
  } finally { captureGate.release(); await pending?.catch(() => {}); await f.cleanup(); }
});

test('tab fallback preserves both streams and closes each client when its stream ends', async () => {
  const f = fixture();
  const a = { req: new EventEmitter(), res: new Response() };
  const b = { req: new EventEmitter(), res: new Response() };
  try {
    await f.hub.stream('browser', 'page-a', a.req, a.res);
    await f.hub.stream('browser', 'page-b', b.req, b.res);
    const original = f.hub.connections.get('browser:page-a');
    const destination = f.hub.connections.get('browser:page-b');
    for (const client of f.clients) client.pages[0].closeTarget();
    await f.hub.refreshPageInventory(original);
    assert.equal(original.pageId, 'page-b');
    assert.equal(f.hub.connections.get('browser:page-b'), destination);
    assert.equal(f.hub.isConnectionActive(original), true);
    assert.equal(original.subscribers.size, 1);
    a.req.emit('close');
    await original.closePromise;
    assert.equal(f.active.size, 1);
    assert.equal(destination.browser.isConnected(), true);
    assert.equal(b.res.writableEnded, false);
    b.req.emit('close');
    await destination.closePromise;
    assertReleased(f);
  } finally { await f.cleanup(); }
});

test('disconnect during stream initialization releases clients and all cleanup listeners', async () => {
  for (let i = 0; i < 20; i++) {
    const connectGate = gate();
    const f = fixture({ connectGate });
    const req = new EventEmitter();
    const res = new Response();
    try {
      const stream = f.hub.stream('browser', 'page-a', req, res);
      await Promise.resolve();
      req.emit('close');
      res.destroyed = true;
      res.emit('close');
      connectGate.release();
      await stream;
      assertReleased(f);
      assert.equal(req.listenerCount('close'), 0);
      assert.equal(res.listenerCount('close'), 0);
      assert.equal(res.listenerCount('finish'), 0);
      assert.equal(res.writes, 0);
    } finally { connectGate.release(); await f.cleanup(); }
  }
});

test('stream inventory setup failure releases its client', async () => {
  const f = fixture({ failAt: 'inventory' });
  const req = new EventEmitter();
  const res = new Response();
  try {
    await assert.rejects(f.hub.stream('browser', 'page-a', req, res), /Inventory failed/);
    assertReleased(f);
    assert.equal(req.listenerCount('close'), 0);
    assert.equal(res.listenerCount('finish'), 0);
  } finally { await f.cleanup(); }
});

test('closing a stream waits for its pending capture before releasing the client', async () => {
  const captureGate = gate();
  const f = fixture({ captureGate });
  const req = new EventEmitter();
  const res = new Response();
  let pending;
  try {
    await f.hub.stream('browser', 'page-a', req, res);
    pending = f.hub.thumbnail('browser', 'page-a');
    await f.hub.preview('browser', 'page-a');
    const connection = f.hub.connections.get('browser:page-a');
    assert.equal(connection.activeOperations, 1);
    req.emit('close');
    assert.equal(f.active.size, 1, 'stream cleanup must not interrupt a capture');
    captureGate.release();
    await pending;
    assertReleased(f);
  } finally { captureGate.release(); await pending?.catch(() => {}); await f.cleanup(); }
});

test('slow stream inventories cannot accumulate overlapping polls', async () => {
  const inventoryGate = gate();
  const f = fixture();
  const req = new EventEmitter();
  const res = new Response();
  const refresh = f.hub.refreshPageInventory.bind(f.hub);
  let calls = 0;
  f.hub.refreshPageInventory = (connection) => {
    calls++;
    return calls === 1 ? refresh(connection) : inventoryGate.promise;
  };
  try {
    await f.hub.stream('browser', 'page-a', req, res);
    await delay(2200);
    assert.equal(calls, 2, 'only the initial inventory and one pending poll may run');
    req.emit('close');
    inventoryGate.release();
    await f.hub.close();
    assertReleased(f);
    assert.equal(req.listenerCount('close'), 0);
    assert.equal(res.listenerCount('finish'), 0);
  } finally { inventoryGate.release(); await f.cleanup(); }
});

test('shutdown waits for pending setup and prevents it from publishing a client', async () => {
  const connectGate = gate();
  const f = fixture({ connectGate });
  try {
    const pending = f.hub.ensureConnection('browser', 'page-a');
    await Promise.resolve();
    const rejected = assert.rejects(pending, /hub is closed/);
    const closing = f.hub.close();
    connectGate.release();
    await Promise.all([rejected, closing]);
    assertReleased(f);
    await assert.rejects(f.hub.ensureConnection('browser', 'page-a'), /hub is closed/);
  } finally { connectGate.release(); await f.cleanup(); }
});

test('slow SSE readers do not accumulate repeated event writes', () => {
  const f = fixture();
  const res = new Response();
  res.writableNeedDrain = true;
  for (let i = 0; i < 1000; i++) f.hub.writeEvent(res, { type: 'pages', pages: [] });
  assert.equal(res.writes, 0);
  res.writableNeedDrain = false;
  f.hub.writeEvent(res, { type: 'pages', pages: [] });
  assert.equal(res.writes, 1);
});
