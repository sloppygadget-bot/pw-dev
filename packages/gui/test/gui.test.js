import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

import { parseArgs } from '../src/cli.js';
import { BrowserMonitorHub } from '../src/monitor.js';
import { resolveStaticPath, startPwDevGuiServer } from '../src/server.js';

test('parseArgs reads gui options', () => {
  const options = parseArgs([
    '--host', '0.0.0.0',
    '--port', '4777',
    '--pwdev-url', 'http://127.0.0.1:9696',
    '--broker-url', 'http://127.0.0.1:18080',
    '--proxy-manager-url', 'http://127.0.0.1:9697',
  ]);

  assert.equal(options.host, '0.0.0.0');
  assert.equal(options.port, 4777);
  assert.equal(options.pwDevUrl, 'http://127.0.0.1:9696');
  assert.equal(options.brokerUrl, 'http://127.0.0.1:18080');
  assert.equal(options.proxyManagerUrl, 'http://127.0.0.1:9697');
});

test('resolveStaticPath keeps gui static requests under root', () => {
  assert.equal(resolveStaticPath('/tmp/gui', '/index.html'), '/tmp/gui/index.html');
  assert.equal(resolveStaticPath('/tmp/gui', '/../secret'), '/tmp/gui/secret');
});

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

test('monitor owns popup dialogs once while excluding GUI pages', async () => {
  const browserDouble = createMonitorBrowserDouble([
    { id: 'target', title: 'Target', url: 'https://dialog.test/' },
    { id: 'gui', title: 'GUI', url: 'http://127.0.0.1:9797/' },
  ]);
  const hub = createConnectedMonitorHub(browserDouble, 'popup-dialog-session');
  hub.addGuiOrigin('http://127.0.0.1:9797');
  try {
    const connection = await hub.ensureConnection('popup-dialog-browser');
    const popup = browserDouble.open({ id: 'popup', title: 'Popup', url: 'https://dialog.test/popup' });
    await hub.refreshPageInventory(connection);
    await hub.refreshPageInventory(connection);
    assert.equal(popup.listenerCount('dialog'), 1);
    assert.equal(browserDouble.page('target').listenerCount('dialog'), 1);
    assert.equal(browserDouble.page('gui').listenerCount('dialog'), 1);
    let dismissals = 0;
    browserDouble.page('gui').emit('dialog', { dismiss: async () => { dismissals += 1; } });
    popup.navigateTo('http://127.0.0.1:9797/');
    popup.emit('dialog', { dismiss: async () => { dismissals += 1; } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dismissals, 0, 'GUI confirmations remain owned by their operator after navigation');
    popup.navigateTo('https://dialog.test/popup');
    popup.emit('dialog', { dismiss: async () => { dismissals += 1; } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dismissals, 1);
  } finally {
    await hub.close();
  }
});

test('monitor remains usable when a second CDP client handles a real confirm dialog', async () => {
  const launched = await launchCdpBrowser();
  let competitor;
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
    competitor = await chromium.connectOverCDP(launched.wsEndpoint);
    const page = competitor.contexts()[0].pages()[0];
    await page.setContent('<button onclick="confirm(\'continue?\')">Confirm</button>');
    await hub.ensureConnection('real-dialog-browser');
    let competingDialogs = 0;
    page.once('dialog', (dialog) => {
      competingDialogs += 1;
      void dialog.accept().catch(() => {});
    });
    await page.click('button');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(competingDialogs, 1);
    assert.equal(unhandled, undefined);
    assert.ok((await hub.preview('real-dialog-browser')).length > 0);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    try {
      await hub.close();
      await competitor?.close();
    } finally {
      await launched.close();
    }
  }
});

test('monitor leaves GUI confirmations to their operator across existing and newly opened tabs', async () => {
  const launched = await launchCdpBrowser();
  const gui = await startJsonServer({ '/gui': { ok: true } });
  const hub = new BrowserMonitorHub({
    pwDevUrl: 'http://pw-dev.test',
    connectOverCDP: (endpoint) => chromium.connectOverCDP(endpoint),
    fetchJson: async () => ({
      ok: true, statusCode: 200,
      body: { browser: { runtime: { sessionId: 'gui-dialogs', cdpUrl: launched.wsEndpoint } } },
    }),
  });
  hub.addGuiOrigin(gui.origin);
  let operator;
  try {
    operator = await chromium.connectOverCDP(launched.wsEndpoint);
    const context = operator.contexts()[0];
    const existingGui = await context.newPage();
    await existingGui.goto(`${gui.origin}/gui`);
    await hub.ensureConnection('gui-dialog-browser');

    for (const createPage of [async () => existingGui, () => context.newPage()]) {
      const page = await createPage();
      if (page !== existingGui) await page.goto(`${gui.origin}/gui`);
      let finishHandling;
      const handled = new Promise((resolve) => { finishHandling = resolve; });
      page.once('dialog', (dialog) => {
        // Leave a deterministic window for an incorrect monitor auto-dismissal.
        setTimeout(() => void dialog.accept().then(() => finishHandling(), finishHandling), 25);
      });
      const accepted = await page.evaluate(() => confirm('Delete this temporary browser?'));
      const handlingError = await handled;
      assert.equal(accepted, true, 'the operator must own its GUI confirmation');
      assert.equal(handlingError, undefined);
      assert.ok((await hub.preview('gui-dialog-browser')).length > 0);
    }
  } finally {
    await hub.close();
    await operator?.close();
    await launched.close();
    await gui.close();
  }
});

test('monitor keeps click telemetry attached across a navigation-context race without serializing DOM', async () => {
  const hub = new BrowserMonitorHub({ pwDevUrl: 'http://127.0.0.1:9696' });
  let evaluations = 0;
  const page = {
    isClosed: () => false,
    exposeFunction: async () => {},
    evaluate: async () => {
      evaluations += 1;
      if (evaluations === 1) throw new Error('Execution context was destroyed, most likely because of a navigation');
      return undefined;
    },
  };
  const connection = {
    browserId: 'navigation-race',
    browser: { isConnected: () => true },
    page,
    subscribers: new Set(),
    bindingName: '__pwdevMonitor_navigation_race',
  };
  hub.connections.set(connection.browserId, connection);

  await hub.refresh(connection);

  assert.equal(evaluations, 2, 'the lightweight click observer should retry without collecting a DOM snapshot');
  assert.equal(connection.lastSnapshot, undefined);
  assert.deepEqual(connection.lastPageState, { type: 'page', browserId: 'navigation-race' });
  assert.equal(connection.refreshPromise, undefined);
});

test('monitor preview uses a short timeout and coalesces concurrent captures', async () => {
  const hub = new BrowserMonitorHub({ pwDevUrl: 'http://127.0.0.1:9696' });
  const captures = [];
  let finishCapture;
  const connection = {
    browserId: 'preview-coalescing',
    browser: { isConnected: () => true },
    page: {
      isClosed: () => false,
      viewportSize: () => ({ width: 1920, height: 1080 }),
      setViewportSize: async () => {},
      screenshot: (options) => {
        captures.push(options);
        return new Promise((resolve) => { finishCapture = resolve; });
      },
    },
    subscribers: new Set(),
    bindingName: '__pwdevMonitor_preview_coalescing',
  };
  hub.connections.set(connection.browserId, connection);

  const first = hub.preview(connection.browserId);
  const second = hub.preview(connection.browserId);
  await waitFor(() => captures.length === 1);

  assert.equal(captures.length, 1);
  assert.deepEqual(captures[0], { type: 'jpeg', quality: 60, scale: 'css', timeout: 2_000 });
  finishCapture(Buffer.from('preview'));
  assert.deepEqual(await Promise.all([first, second]), [Buffer.from('preview'), Buffer.from('preview')]);
  assert.equal(hub.previewPromises.has(connection.browserId), false);
});

test('monitor restores the 1080p minimum before every screenshot', async () => {
  const browserDouble = createMonitorBrowserDouble([
    { id: 'resized-page', title: 'Resized', url: 'https://shop.test/' },
  ]);
  const hub = new BrowserMonitorHub({
    pwDevUrl: 'http://pw-dev.test',
    connectOverCDP: async () => browserDouble.browser,
    fetchJson: async () => ({
      ok: true,
      statusCode: 200,
      body: { browser: { runtime: { sessionId: 'resized-session', cdpUrl: 'http://broker.test/session' } } },
    }),
  });

  try {
    await hub.ensureConnection('resized-browser', 'resized-page');
    await browserDouble.page('resized-page').setViewportSize({ width: 800, height: 600 });

    await hub.preview('resized-browser', 'resized-page');

    assert.deepEqual(browserDouble.page('resized-page').viewportSize(), { width: 1920, height: 1080 });
  } finally {
    await hub.close();
  }
});

test('monitor relays real browser click coordinates to its event subscribers', () => {
  const hub = new BrowserMonitorHub({ pwDevUrl: 'http://127.0.0.1:9696' });
  const events = [];
  const connection = {
    browserId: 'click-indicator',
    subscribers: new Set([{ destroyed: false, write: (value) => events.push(value) }]),
  };

  hub.handlePageEvent(connection, {
    type: 'click',
    x: 320,
    y: 180,
    viewport: { width: 1280, height: 720 },
  });

  assert.deepEqual(events, [
    'data: {"type":"click","x":320,"y":180,"viewport":{"width":1280,"height":720},"browserId":"click-indicator"}\n\n',
  ]);
});

test('monitor raises a short browser viewport to a true 1080p minimum', async () => {
  const browserDouble = createMonitorBrowserDouble([
    { id: 'wide-page', title: 'Wide', url: 'https://shop.test/', viewport: { width: 2560, height: 720 } },
  ]);
  const hub = new BrowserMonitorHub({
    pwDevUrl: 'http://pw-dev.test',
    connectOverCDP: async () => browserDouble.browser,
    fetchJson: async () => ({
      ok: true,
      statusCode: 200,
      body: { browser: { runtime: { sessionId: 'viewport-session', cdpUrl: 'http://broker.test/session' } } },
    }),
  });

  try {
    const connection = await hub.ensureConnection('viewport-browser', 'wide-page');

    assert.deepEqual(browserDouble.page('wide-page').viewportSize(), { width: 2560, height: 1080 });
    assert.deepEqual(connection.lastPageState.viewport, { width: 2560, height: 1080, devicePixelRatio: 1 });
  } finally {
    await hub.close();
  }
});

test('monitor routes mouse input to the selected Playwright page', async () => {
  const browserDouble = createMonitorBrowserDouble([
    { id: 'input-page', title: 'Input', url: 'https://shop.test/' },
  ]);
  const hub = new BrowserMonitorHub({
    pwDevUrl: 'http://pw-dev.test',
    connectOverCDP: async () => browserDouble.browser,
    fetchJson: async () => ({
      ok: true,
      statusCode: 200,
      body: { browser: { runtime: { sessionId: 'input-session', cdpUrl: 'http://broker.test/session' } } },
    }),
  });

  try {
    await hub.action('input-browser', 'input-page', { action: 'pointer', type: 'move', x: 120, y: 240 });
    await hub.action('input-browser', 'input-page', { action: 'pointer', type: 'down', x: 120, y: 240, button: 'left' });
    await hub.action('input-browser', 'input-page', { action: 'pointer', type: 'up', x: 120, y: 240, button: 'left' });
    await hub.action('input-browser', 'input-page', { action: 'pointer', type: 'wheel', x: 120, y: 240, deltaX: 5, deltaY: 80 });

    assert.deepEqual(browserDouble.page('input-page').inputActions, [
      { device: 'mouse', type: 'move', x: 120, y: 240 },
      { device: 'mouse', type: 'move', x: 120, y: 240 },
      { device: 'mouse', type: 'down', button: 'left' },
      { device: 'mouse', type: 'move', x: 120, y: 240 },
      { device: 'mouse', type: 'up', button: 'left' },
      { device: 'mouse', type: 'move', x: 120, y: 240 },
      { device: 'mouse', type: 'wheel', deltaX: 5, deltaY: 80 },
    ]);
  } finally {
    await hub.close();
  }
});

test('monitor rejects mouse coordinates outside the target viewport', async () => {
  const browserDouble = createMonitorBrowserDouble([
    { id: 'bounded-page', title: 'Bounded', url: 'https://shop.test/' },
  ]);
  const hub = new BrowserMonitorHub({
    pwDevUrl: 'http://pw-dev.test',
    connectOverCDP: async () => browserDouble.browser,
    fetchJson: async () => ({
      ok: true,
      statusCode: 200,
      body: { browser: { runtime: { sessionId: 'bounded-session', cdpUrl: 'http://broker.test/session' } } },
    }),
  });

  try {
    await assert.rejects(
      hub.action('bounded-browser', 'bounded-page', { action: 'pointer', type: 'down', x: 1920, y: 540 }),
      /pointer coordinates must be within the target viewport/,
    );
    assert.deepEqual(browserDouble.page('bounded-page').inputActions, []);
  } finally {
    await hub.close();
  }
});

test('monitor routes keyboard and pasted text to the selected Playwright page', async () => {
  const browserDouble = createMonitorBrowserDouble([
    { id: 'input-page', title: 'Input', url: 'https://shop.test/' },
  ]);
  const hub = new BrowserMonitorHub({
    pwDevUrl: 'http://pw-dev.test',
    connectOverCDP: async () => browserDouble.browser,
    fetchJson: async () => ({
      ok: true,
      statusCode: 200,
      body: { browser: { runtime: { sessionId: 'input-session', cdpUrl: 'http://broker.test/session' } } },
    }),
  });

  try {
    await hub.action('input-browser', 'input-page', { action: 'keyboard', type: 'down', key: 'Shift' });
    await hub.action('input-browser', 'input-page', { action: 'keyboard', type: 'up', key: 'Shift' });
    await hub.action('input-browser', 'input-page', { action: 'keyboard', type: 'insertText', text: 'hello' });

    assert.deepEqual(browserDouble.page('input-page').inputActions, [
      { device: 'keyboard', type: 'down', key: 'Shift' },
      { device: 'keyboard', type: 'up', key: 'Shift' },
      { device: 'keyboard', type: 'insertText', text: 'hello' },
    ]);
  } finally {
    await hub.close();
  }
});

test('monitor routes back, forward, and reload to the selected Playwright page', async () => {
  const browserDouble = createMonitorBrowserDouble([
    { id: 'navigation-page', title: 'Navigation', url: 'https://example.test/' },
  ]);
  const hub = new BrowserMonitorHub({
    pwDevUrl: 'http://pw-dev.test',
    connectOverCDP: async () => browserDouble.browser,
    fetchJson: async () => ({
      ok: true,
      statusCode: 200,
      body: { browser: { runtime: { sessionId: 'navigation-session', cdpUrl: 'http://broker.test/session' } } },
    }),
  });

  try {
    await hub.action('navigation-browser', 'navigation-page', { action: 'navigation', type: 'back' });
    await hub.action('navigation-browser', 'navigation-page', { action: 'navigation', type: 'forward' });
    await hub.action('navigation-browser', 'navigation-page', { action: 'navigation', type: 'reload' });

    assert.deepEqual(browserDouble.page('navigation-page').navigationActions, [
      { type: 'back', options: { waitUntil: 'commit', timeout: 10_000 } },
      { type: 'forward', options: { waitUntil: 'commit', timeout: 10_000 } },
      { type: 'reload', options: { waitUntil: 'commit', timeout: 10_000 } },
    ]);
  } finally {
    await hub.close();
  }
});

test('monitor preserves input ordering across concurrent requests', async () => {
  const browserDouble = createMonitorBrowserDouble([
    { id: 'ordered-page', title: 'Ordered', url: 'https://shop.test/' },
  ]);
  const hub = new BrowserMonitorHub({
    pwDevUrl: 'http://pw-dev.test',
    connectOverCDP: async () => browserDouble.browser,
    fetchJson: async () => ({
      ok: true,
      statusCode: 200,
      body: { browser: { runtime: { sessionId: 'ordered-session', cdpUrl: 'http://broker.test/session' } } },
    }),
  });

  try {
    await hub.ensureConnection('ordered-browser', 'ordered-page');
    const page = browserDouble.page('ordered-page');
    let releaseMove;
    page.mouse.move = async () => {
      page.inputActions.push({ type: 'move-start' });
      await new Promise((resolve) => { releaseMove = resolve; });
      page.inputActions.push({ type: 'move-end' });
    };
    page.keyboard.down = async (key) => page.inputActions.push({ type: 'key-down', key });

    const pointer = hub.action('ordered-browser', 'ordered-page', { action: 'pointer', type: 'move', x: 1, y: 2 });
    while (!releaseMove) await new Promise((resolve) => setImmediate(resolve));
    const keyboard = hub.action('ordered-browser', 'ordered-page', { action: 'keyboard', type: 'down', key: 'A' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(page.inputActions, [{ type: 'move-start' }]);
    releaseMove();
    await Promise.all([pointer, keyboard]);
    assert.deepEqual(page.inputActions, [
      { type: 'move-start' },
      { type: 'move-end' },
      { type: 'key-down', key: 'A' },
    ]);
  } finally {
    await hub.close();
  }
});

test('monitor preserves action request order when cached-target revalidation resolves out of order', async () => {
  const browserDouble = createMonitorBrowserDouble([
    { id: 'ordered-page', title: 'Ordered', url: 'https://shop.test/' },
  ]);
  const hub = createConnectedMonitorHub(browserDouble, 'ordered-revalidation-session');
  hub.addGuiOrigin('http://127.0.0.1:9797');

  try {
    await hub.ensureConnection('ordered-revalidation-browser', 'ordered-page');
    const page = browserDouble.page('ordered-page');
    const deferredDescription = browserDouble.deferNextPageDescription();

    const pointer = hub.action('ordered-revalidation-browser', 'ordered-page', { action: 'pointer', type: 'move', x: 1, y: 2 });
    await deferredDescription.started;
    const keyboard = hub.action('ordered-revalidation-browser', 'ordered-page', { action: 'keyboard', type: 'down', key: 'A' });
    await new Promise((resolve) => setImmediate(resolve));
    const actionsBeforeFirstRevalidation = [...page.inputActions];

    deferredDescription.release();
    await Promise.all([pointer, keyboard]);

    assert.deepEqual(actionsBeforeFirstRevalidation, []);
    assert.deepEqual(page.inputActions, [
      { device: 'mouse', type: 'move', x: 1, y: 2 },
      { device: 'keyboard', type: 'down', key: 'A' },
    ]);
  } finally {
    await hub.close();
  }
});

test('monitor preserves action request order across default and explicit page aliases', async () => {
  const browserDouble = createMonitorBrowserDouble([
    { id: 'ordered-page', title: 'Ordered', url: 'https://shop.test/' },
  ]);
  const hub = createConnectedMonitorHub(browserDouble, 'ordered-alias-session');
  hub.addGuiOrigin('http://127.0.0.1:9797');

  try {
    await hub.ensureConnection('ordered-alias-browser');
    const page = browserDouble.page('ordered-page');
    const deferredDescription = browserDouble.deferNextPageDescription();

    const pointer = hub.action('ordered-alias-browser', undefined, { action: 'pointer', type: 'move', x: 1, y: 2 });
    await deferredDescription.started;
    const keyboard = hub.action('ordered-alias-browser', 'ordered-page', { action: 'keyboard', type: 'down', key: 'A' });
    await new Promise((resolve) => setImmediate(resolve));
    const actionsBeforeFirstRevalidation = [...page.inputActions];

    deferredDescription.release();
    await Promise.all([pointer, keyboard]);

    assert.deepEqual(actionsBeforeFirstRevalidation, []);
    assert.deepEqual(page.inputActions, [
      { device: 'mouse', type: 'move', x: 1, y: 2 },
      { device: 'keyboard', type: 'down', key: 'A' },
    ]);
  } finally {
    await hub.close();
  }
});

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

test('monitor falls back before preview when the cached target navigates to the GUI', async () => {
  const browserDouble = createMonitorBrowserDouble([
    { id: 'target', title: 'Target', url: 'http://127.0.0.1:3000/' },
    { id: 'fallback', title: 'Fallback', url: 'http://127.0.0.1:4000/', viewport: { width: 1024, height: 768 } },
  ]);
  const hub = createConnectedMonitorHub(browserDouble, 'navigation-fallback-session');
  hub.addGuiOrigin('http://127.0.0.1:9797');

  try {
    const connection = await hub.ensureConnection('navigation-fallback-browser', 'target');
    await browserDouble.page('target').setViewportSize({ width: 390, height: 844 });
    browserDouble.page('target').navigateTo('http://127.0.0.1:9797/monitor/navigation-fallback-browser');

    await hub.refresh(connection);

    assert.equal(connection.pageId, 'fallback');
    assert.equal(connection.lastPageState.url, 'http://127.0.0.1:4000/');
    const preview = await hub.preview('navigation-fallback-browser', 'fallback');

    assert.deepEqual(preview, Buffer.from('fallback'));
    assert.deepEqual(browserDouble.page('fallback').viewportSize(), { width: 1920, height: 1080 });
    assert.deepEqual(browserDouble.page('target').viewportSize(), { width: 390, height: 844 });
  } finally {
    await hub.close();
  }
});

test('monitor rejects actions when the cached target navigates to the GUI without a fallback', async () => {
  const browserDouble = createMonitorBrowserDouble([
    { id: 'target', title: 'Target', url: 'http://127.0.0.1:3000/' },
  ]);
  const hub = createConnectedMonitorHub(browserDouble, 'navigation-gui-only-session');
  hub.addGuiOrigin('http://127.0.0.1:9797');

  try {
    await hub.ensureConnection('navigation-gui-only-browser', 'target');
    await browserDouble.page('target').setViewportSize({ width: 390, height: 844 });
    browserDouble.page('target').navigateTo('http://127.0.0.1:9797/monitor/navigation-gui-only-browser');

    await assert.rejects(
      hub.action('navigation-gui-only-browser', 'target', { action: 'click', path: [1] }),
      (error) => error.statusCode === 409 && error.message === 'Browser session has no monitorable page',
    );
    assert.deepEqual(browserDouble.page('target').actions, []);
    assert.deepEqual(browserDouble.page('target').viewportSize(), { width: 390, height: 844 });
  } finally {
    await hub.close();
  }
});

for (const transition of ['navigation', 'close']) {
  test(`monitor ends established streams when the final external target disappears by ${transition}`, async (t) => {
    const browserDouble = createMonitorBrowserDouble([
      { id: 'target', title: 'Target', url: 'https://target.test/' },
      { id: 'gui', title: 'GUI', url: 'http://127.0.0.1:9797/' },
    ]);
    const hub = createConnectedMonitorHub(browserDouble, 'no-target-session');
    hub.addGuiOrigin('http://127.0.0.1:9797');
    const intervals = new Set();
    const nativeSetInterval = globalThis.setInterval;
    const nativeClearInterval = globalThis.clearInterval;
    t.mock.method(globalThis, 'setInterval', (...args) => {
      const timer = nativeSetInterval(...args);
      intervals.add(timer);
      return timer;
    });
    t.mock.method(globalThis, 'clearInterval', (timer) => {
      intervals.delete(timer);
      nativeClearInterval(timer);
    });
    const requests = [new EventEmitter(), new EventEmitter()];
    const responses = [new MonitorResponseDouble(), new MonitorResponseDouble()];
    try {
      await hub.stream('no-target-browser', 'target', requests[0], responses[0]);
      await hub.stream('no-target-browser', 'target', requests[1], responses[1]);
      const connection = hub.connections.get('no-target-browser:target');
      assert.equal(connection.subscribers.size, 2);
      assert.equal(intervals.size, 4);
      if (transition === 'navigation') browserDouble.page('target').navigateTo('http://127.0.0.1:9797/');
      else browserDouble.closePage('target');

      await assert.rejects(hub.refreshPageInventory(connection), /no monitorable page/i);

      for (const response of responses) {
        assert.equal(response.events().at(-1).type, 'no-target');
        assert.deepEqual(response.events().at(-1).pages, []);
        assert.equal(response.writableEnded, true);
      }
      assert.equal(connection.lastPageState, undefined);
      assert.equal(connection.subscribers.size, 0);
      assert.equal(intervals.size, 0, 'both inventory and keepalive timers are released for every subscriber');
      assert.equal(hub.connections.size, 0);
      assert.equal(browserDouble.closeCalls, 1);
    } finally {
      for (const request of requests) request.emit('close');
      await hub.close();
    }
  });
}

test('dashboard exposes active view state and contains README modal focus', async () => {
  const browser = await chromium.launch({ headless: true });
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub: { async close() {} } });
  try {
    const page = await browser.newPage();
    await routeDashboardSnapshot(page, snapshotWithReadme());
    await page.goto(gui.origin);

    const browsersNav = page.locator('.nav-item[data-view="browsers"]');
    assert.equal(await browsersNav.getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('.nav-item[aria-current="page"]').count(), 1);
    await page.locator('summary', { hasText: 'Assets' }).click();
    await page.locator('.nav-item[data-view="apps"]').click();
    assert.equal(await browsersNav.getAttribute('aria-current'), null);
    assert.equal(await page.locator('.nav-item[data-view="apps"]').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('.nav-item[aria-current="page"]').count(), 1);

    await browsersNav.click();
    assert.equal(await page.locator('[data-browser-view="diagram"]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-browser-view="table"]').click();
    assert.equal(await page.locator('[data-browser-view="diagram"]').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('[data-browser-view="table"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-browser-view][aria-pressed="true"]').count(), 1);

    await page.locator('.nav-item[data-view="apps"]').click();
    const invoker = page.getByRole('button', { name: 'View README' }).first();
    await invoker.click();
    assert.equal(await page.locator('#page-shell').getAttribute('inert'), '');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'copy-markdown-modal');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'close-markdown-modal');
    await page.keyboard.press('Escape');
    assert.equal(await invoker.evaluate((button) => document.activeElement === button), true);
    assert.equal(await page.locator('#page-shell').getAttribute('inert'), null);

    await invoker.click();
    await page.locator('[data-close-markdown-modal]').click({ position: { x: 4, y: 4 } });
    assert.equal(await invoker.evaluate((button) => document.activeElement === button), true);
    assert.equal(await page.locator('#page-shell').getAttribute('inert'), null);
    await invoker.click();
    await page.locator('#close-markdown-modal').click();
    assert.equal(await invoker.evaluate((button) => document.activeElement === button), true);
    assert.equal(await page.locator('#page-shell').getAttribute('inert'), null);
  } finally {
    await browser.close();
    await gui.close();
  }
});

for (const width of [390, 850, 851]) {
test(`dashboard navigation uses the accordion breakpoint at ${width}px`, async () => {
  const browser = await chromium.launch({ headless: true });
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub: { async close() {} } });
  try {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    await routeDashboardSnapshot(page, browserPreviewSnapshot());
    await page.goto(gui.origin);

    const assets = page.locator('[data-nav-group="assets"]');
    const runtime = page.locator('[data-nav-group="runtime"]');
    await assets.locator('summary').click();
    await page.locator('.nav-item[data-view="apps"]').click();
    await runtime.locator('summary').click();
    assert.equal(await assets.getAttribute('open'), '');
    assert.equal(await runtime.getAttribute('open'), '');

    await page.locator('.nav-item[data-view="sessions"]').click();
    assert.equal(await assets.getAttribute('open'), width <= 850 ? null : '');
    assert.equal(await runtime.getAttribute('open'), '');
    assert.equal(await page.locator('.nav-item[data-view="sessions"]').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('.nav-item[aria-current="page"]').count(), 1);
    if (width <= 850) {
      const boxes = await page.locator('.nav-links > *').evaluateAll((elements) => elements.map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      }));
      for (const [index, box] of boxes.entries()) {
        assert.equal(box.x, boxes[0].x, 'mobile navigation occupies one column');
        assert.equal(box.width, boxes[0].width);
        if (index) assert.ok(box.y >= boxes[index - 1].y + boxes[index - 1].height);
      }
    }
  } finally {
    await browser.close();
    await gui.close();
  }
});
}

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
    const browserHeading = page.getByRole('heading', { name: 'Preview browser' });
    await browserHeading.waitFor();
    await page.locator('#interval').evaluate((select) => {
      select.append(new Option('test', '50'));
      select.value = '50';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector('#refresh-status')?.dataset.state === 'error');
    assert.equal(await browserHeading.count(), 1);
    await page.waitForFunction(() => document.querySelector('#refresh-status')?.dataset.state === 'ok');
    assert.ok(requests >= 3, 'automatic polling must continue after failure');
    assert.equal(await page.locator('#refresh').isDisabled(), false);
  } finally {
    await browser.close();
    await gui.close();
  }
});

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
    await page.getByRole('heading', { name: 'Preview browser' }).waitFor();
  } finally {
    await browser.close();
    await gui.close();
  }
});

test('dashboard retries unavailable configuration before enabling creation controls', async () => {
  const browser = await chromium.launch({ headless: true });
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub: { async close() {} } });
  let configAvailable = false;
  let configRequests = 0;
  let snapshotRequests = 0;
  try {
    const page = await browser.newPage();
    await page.route('**/api/config', (route) => {
      configRequests += 1;
      return configAvailable
        ? route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, pwDevUrl: 'http://pw-dev.test' }),
        })
        : route.fulfill({ status: 503, body: 'config unavailable' });
    });
    await page.route('**/api/snapshot', (route) => {
      snapshotRequests += 1;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(browserPreviewSnapshot()) });
    });
    await page.route('**/api/pwdev/sessions/preview-session/pages', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ pages: [] }),
    }));

    await page.goto(gui.origin);
    await page.waitForFunction(() => document.querySelector('#refresh-status')?.dataset.state === 'error');
    for (const selector of ['#new-browser', '#new-browser-config', '#new-proxy']) {
      assert.equal(await page.locator(selector).isDisabled(), true);
    }
    assert.equal(snapshotRequests, 0, 'snapshot loading must wait for configuration');

    configAvailable = true;
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.querySelector('#refresh-status')?.dataset.state === 'ok');
    await page.getByRole('heading', { name: 'Preview browser' }).waitFor();
    for (const selector of ['#new-browser', '#new-browser-config', '#new-proxy']) {
      assert.equal(await page.locator(selector).isEnabled(), true);
    }
    assert.equal(configRequests, 2, 'manual refresh must retry configuration');
    assert.equal(snapshotRequests, 1);
  } finally {
    await browser.close();
    await gui.close();
  }
});

test('dashboard restores the last rendered snapshot after a later renderer fails', async () => {
  const browser = await chromium.launch({ headless: true });
  const seedPage = await browser.newPage({ viewport: { width: 160, height: 90 } });
  await seedPage.setContent('<body style="margin:0;background:#36c"></body>');
  const preview = await seedPage.screenshot({ type: 'jpeg' });
  await seedPage.close();
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub: { async close() {} } });
  let snapshotRequests = 0;
  let previewRequests = 0;
  try {
    const page = await browser.newPage();
    await page.route('**/api/config', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, pwDevUrl: 'http://pw-dev.test' }),
    }));
    await page.route('**/api/snapshot', (route) => {
      snapshotRequests += 1;
      const snapshot = browserPreviewSnapshot();
      if (snapshotRequests === 2) {
        snapshot.server.browsers.body.browsers[0].name = 'Broken browser';
        snapshot.server.remoteHosts.body.remoteHosts = [null];
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(snapshot) });
    });
    await page.route('**/api/pwdev/sessions/preview-session/pages', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ pages: [{ id: 'preview-page', title: 'Preview', url: 'https://preview.test/' }] }),
    }));
    await page.route('**/api/monitor/preview-browser/preview*', (route) => {
      previewRequests += 1;
      return previewRequests === 1
        ? route.fulfill({ contentType: 'image/jpeg', body: preview })
        : route.fulfill({ status: 503, body: 'preview unavailable' });
    });

    await page.goto(gui.origin);
    const priorHeading = page.getByRole('heading', { name: 'Preview browser' });
    const thumbnail = page.locator('.browser-preview img');
    await priorHeading.waitFor();
    await thumbnail.waitFor({ state: 'visible' });
    const priorSrc = await thumbnail.getAttribute('src');

    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.querySelector('#refresh-status')?.dataset.state === 'error');
    assert.equal(await priorHeading.count(), 1);
    assert.equal(await page.getByRole('heading', { name: 'Broken browser' }).count(), 0);
    assert.equal(await thumbnail.getAttribute('src'), priorSrc);
    assert.equal(await thumbnail.isVisible(), true);
  } finally {
    await browser.close();
    await gui.close();
  }
});

test('two-tab monitor resolves targets, routes actions, discovers popups, falls back, and cleans up', async () => {
  const browserDouble = createMonitorBrowserDouble([
    { id: 'page-a', title: 'Home', url: 'https://shop.test/' },
    { id: 'page-b', title: 'Birds', url: 'https://shop.test/birds' },
  ]);
  const fetchedUrls = [];
  const hub = new BrowserMonitorHub({
    pwDevUrl: 'http://pw-dev.test',
    connectOverCDP: async (cdpUrl) => {
      assert.equal(cdpUrl, 'http://broker.test/session');
      return browserDouble.browser;
    },
    fetchJson: async (rawUrl) => {
      fetchedUrls.push(rawUrl);
      if (rawUrl.endsWith('/_pwdev/browsers/shared-browser')) {
        return { ok: true, statusCode: 200, body: { browser: { runtime: { sessionId: 'shared-session', cdpUrl: 'http://broker.test/session' } } } };
      }
      if (rawUrl.endsWith('/_pwdev/sessions/shared-session/pages')) {
        return {
          ok: true,
          statusCode: 200,
          body: { pages: browserDouble.livePages().map((page) => ({ id: page.id, title: page.titleValue, url: page.url(), ...(page.lease ? { lease: page.lease } : {}) })) },
        };
      }
      return { ok: false, statusCode: 404, body: {} };
    },
  });
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub: hub });
  try {
    const selected = await hub.ensureConnection('shared-browser', 'page-b');
    assert.equal(selected.pageId, 'page-b');
    assert.equal(selected.page, browserDouble.page('page-b'));

    const action = await postJson(`${gui.origin}/api/monitor/shared-browser/action?pageId=page-b`, { action: 'click', path: [1, 2] });
    assert.equal(action.statusCode, 200);
    assert.deepEqual(browserDouble.page('page-a').actions, []);
    assert.deepEqual(browserDouble.page('page-b').actions, [{ action: 'click', path: [1, 2], behavior: undefined }]);

    const req = new EventEmitter();
    const res = new MonitorResponseDouble();
    await hub.stream('shared-browser', 'page-b', req, res);
    const connected = res.events().find((event) => event.type === 'connected');
    assert.equal(connected.pageId, 'page-b');

    browserDouble.open({ id: 'page-c', title: 'Bird popup', url: 'https://shop.test/birds/cockatiel', lease: { owner: 'popup-agent' } });
    const withPopup = await hub.refreshPageInventory(selected);
    assert.deepEqual(withPopup.map((page) => page.id), ['page-a', 'page-b', 'page-c']);
    assert.equal(withPopup[2].lease.owner, 'popup-agent');

    browserDouble.closePage('page-b');
    const afterClose = await hub.refreshPageInventory(selected);
    assert.deepEqual(afterClose.map((page) => page.id), ['page-a', 'page-c']);
    assert.equal(selected.pageId, 'page-a');
    assert.equal(selected.page, browserDouble.page('page-a'));
    assert.equal(hub.connections.get('shared-browser:page-a'), selected);
    assert.equal(hub.connections.has('shared-browser:page-b'), false);

    req.emit('close');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(browserDouble.closeCalls, 1);
    assert.equal(hub.connections.size, 0);
    assert.equal(fetchedUrls.some((url) => url.endsWith('/_pwdev/sessions/shared-session/pages')), true);
  } finally {
    await gui.close();
  }
});

test('monitor applies the 1080p minimum when it falls back to another tab', async () => {
  const browserDouble = createMonitorBrowserDouble([
    { id: 'page-a', title: 'First', url: 'https://shop.test/a' },
  ]);
  const hub = new BrowserMonitorHub({
    pwDevUrl: 'http://pw-dev.test',
    connectOverCDP: async () => browserDouble.browser,
    fetchJson: async (rawUrl) => {
      if (rawUrl.endsWith('/_pwdev/browsers/fallback-browser')) {
        return { ok: true, statusCode: 200, body: { browser: { runtime: { sessionId: 'fallback-session', cdpUrl: 'http://broker.test/session' } } } };
      }
      return { ok: true, statusCode: 200, body: { pages: [] } };
    },
  });

  try {
    const connection = await hub.ensureConnection('fallback-browser', 'page-a');
    browserDouble.open({ id: 'page-b', title: 'Second', url: 'https://shop.test/b', viewport: { width: 1024, height: 768 } });
    browserDouble.closePage('page-a');

    await hub.refreshPageInventory(connection);

    assert.equal(connection.pageId, 'page-b');
    assert.deepEqual(browserDouble.page('page-b').viewportSize(), { width: 1920, height: 1080 });
    assert.deepEqual(connection.lastPageState.viewport, { width: 1920, height: 1080, devicePixelRatio: 1 });
  } finally {
    await hub.close();
  }
});

test('gui serves static app and read-only config', async () => {
  const server = await startPwDevGuiServer({
    port: 0,
    pwDevUrl: 'http://127.0.0.1:9696',
    brokerUrl: 'http://127.0.0.1:18080',
    proxyManagerUrl: 'http://127.0.0.1:9697',
    brokerDiscovery: false,
  });

  try {
    const index = await get(`${server.origin}/`);
    assert.equal(index.statusCode, 200);
    assert.match(index.body, /<h1>pw-dev<\/h1>/);
    assert.match(index.body, /Browsers/);
    assert.match(index.body, /id="broker-card"/);
    assert.match(index.body, /id="broker-state"><span class="good-text">online: 0<\/span><\/strong>/);
    assert.doesNotMatch(index.body, /data-view="topology"/);
    assert.match(index.body, /data-view="broker"/);
    assert.match(index.body, /data-browser-view="diagram"/);
    assert.match(index.body, /data-browser-view="table"/);
    assert.match(index.body, /id="new-browser"/);
    assert.match(index.body, /id="browser-editor"/);
    assert.match(index.body, /id="new-browser-config"/);
    assert.match(index.body, /id="browser-config-editor"/);
    assert.match(index.body, /id="browser-config-ignore-ssl-errors"[^>]*checked/);
    assert.match(index.body, /id="markdown-modal"/);
    assert.match(index.body, /id="nav-toggle"[^>]*aria-expanded="true"[^>]*aria-controls="entity-navigation"/);
    assert.match(index.body, /id="entity-navigation" class="nav-links"/);
    assert.match(index.body, /<details class="nav-group" data-nav-group="assets">/);
    assert.match(index.body, /<details class="nav-group" data-nav-group="runtime">/);
    assert.doesNotMatch(index.body, /data-nav-group="assets" open/);
    assert.doesNotMatch(index.body, /data-nav-group="runtime" open/);
    assert.match(index.body, /id="new-proxy"/);
    assert.match(index.body, /id="proxy-editor"/);
    assert.match(index.body, /href="\/api-docs"/);
    assert.doesNotMatch(index.body, /data-view="networks"/);

    const apiDocs = await get(`${server.origin}/api-docs/`);
    assert.equal(apiDocs.statusCode, 200);
    assert.match(apiDocs.body, /swagger-ui-bundle\.js/);

    const swaggerBundle = await get(`${server.origin}/api-docs/swagger-ui/swagger-ui-bundle.js`);
    assert.equal(swaggerBundle.statusCode, 200);
    assert.match(swaggerBundle.headers['content-type'], /javascript/);

    const monitor = await get(`${server.origin}/monitor/example-browser`);
    assert.equal(monitor.statusCode, 200);
    assert.doesNotMatch(monitor.body, /<h2>Live DOM mirror<\/h2>/);
    assert.match(monitor.body, /<title>pw-dev screenshot monitor<\/title>/);
    assert.match(monitor.body, /id="mirror-image"/);
    assert.doesNotMatch(monitor.body, /id="mirror-frame"/);
    assert.match(monitor.body, /id="nav-target-url"/);
    assert.match(monitor.body, /id="nav-back"[^>]*aria-label="Back"/);
    assert.match(monitor.body, /id="nav-forward"[^>]*aria-label="Forward"/);
    assert.match(monitor.body, /id="nav-reload"[^>]*aria-label="Reload"/);
    assert.match(monitor.body, /class="browser-toolbar"[\s\S]*id="nav-back"[\s\S]*id="nav-target-url"/);
    assert.doesNotMatch(monitor.body, /<header class="monitor-topbar">[\s\S]*id="nav-back"[\s\S]*<\/header>/);
    assert.match(monitor.body, /id="mirror-click-marker"/);
    assert.match(monitor.body, /id="refresh-screenshot"/);
    assert.match(monitor.body, /id="page-summary"/);
    const monitorScript = await get(`${server.origin}/monitor.js`);
    assert.equal(monitorScript.statusCode, 200);
    assert.match(monitorScript.body, /EventSource/);
    assert.match(monitorScript.body, /refreshScreenshot/);
    assert.match(monitorScript.body, /monitorUrl\('preview'\)/);
    assert.match(monitorScript.body, /placeClickMarker/);
    assert.doesNotMatch(monitorScript.body, /sanitizeHtml/);
    assert.doesNotMatch(monitorScript.body, /Rendering DOM snapshot/);
    assert.match(monitorScript.body, /click\.x \* scale/);
    assert.match(monitorScript.body, /image\.getBoundingClientRect/);
    assert.match(monitorScript.body, /pageMeta\.title = meta/);
    const monitorSource = await fs.readFile(new URL('../src/monitor.js', import.meta.url), 'utf8');
    assert.match(monitorSource, /browserRecord\.body\?\.browser\?\.runtime/);
    assert.match(monitorSource, /browserRecord\.body\?\.browser\?\.sessions\?\.\[0\]/);
    assert.match(monitorSource, /preview\(browserId, pageId\)/);
    assert.match(monitorSource, /async capturePreview\(browserId, pageId\)/);
    assert.match(monitorSource, /Target\.getTargetInfo/);
    assert.match(monitorSource, /Live screenshot monitor requires Playwright/);
    assert.doesNotMatch(monitorSource, /MutationObserver/);
    const monitorStyle = await get(`${server.origin}/monitor.css`);
    assert.equal(monitorStyle.statusCode, 200);
    assert.match(monitorStyle.body, /mirror-image/);
    assert.match(monitorStyle.body, /object-fit: contain/);
    assert.match(monitorStyle.body, /\.browser-address/);
    assert.match(monitorStyle.body, /\.mirror-head #page-meta/);

    const appScript = await get(`${server.origin}/app.js`);
    assert.equal(appScript.statusCode, 200);
    assert.match(appScript.body, /function renderTable/);
    assert.match(appScript.body, /function normalizeBrowser/);
    assert.match(appScript.body, /browser\.runtime \?\? browser\.sessions\?\.\[0\]/);
    assert.match(appScript.body, /const sessionId = browser\.sessionId \?\? session\?\.sessionId/);
    assert.match(appScript.body, /Used By/);
    assert.match(appScript.body, /function showApp/);
    assert.match(appScript.body, /function setNavCollapsed\(collapsed\)/);
    assert.match(appScript.body, /classList\.toggle\('nav-collapsed', collapsed\)/);
    assert.match(appScript.body, /function showProxy/);
    assert.match(appScript.body, /function showBrowserConfig/);
    assert.match(appScript.body, /function showSession/);
    assert.match(appScript.body, /function sessionLink/);
    assert.match(appScript.body, /function appLink/);
    assert.match(appScript.body, /function proxyLink/);
    assert.match(appScript.body, /function browserConfigLink/);
    assert.match(appScript.body, /session-target/);
    assert.match(appScript.body, /function renderMarkdown/);
    assert.match(appScript.body, /function openMarkdownModal/);
    assert.match(appScript.body, /View README/);
    assert.match(appScript.body, /GUI URL/);
    assert.match(appScript.body, /function proxyGuiLink/);
    assert.match(appScript.body, /function saveBrowser/);
    assert.match(appScript.body, /function browserActions/);
    assert.match(appScript.body, /label: 'Delete',\s*disabled: deleteBlocked/);
    assert.doesNotMatch(appScript.body, /label: 'Delete browser',\s*disabled: deleteBlocked/);
    assert.match(appScript.body, /function saveBrowserConfig/);
    assert.match(appScript.body, /browserConfigIgnoreSslErrors\.checked = browserConfig\?\.ignoreSslErrors \?\? true/);
    assert.match(appScript.body, /function browserConfigActions/);
    assert.match(appScript.body, /function brokerForBrowserConfig\(browserConfig, brokers\)/);
    assert.match(appScript.body, /\['Browser config', 'Target', 'Broker', 'Profile', 'Used By', 'Active sessions', 'Actions'\]/);
    assert.match(appScript.body, /browserConfig\.brokerUrl\s*\?\? brokers\.find/);
    assert.match(appScript.body, /function saveProxy/);
    assert.match(appScript.body, /function proxyActions/);
    assert.match(appScript.body, /label: 'Monitor'/);
    assert.match(appScript.body, /Found on localhost/);
    assert.match(appScript.body, /Broker host hostname/);
    assert.match(appScript.body, /broker\?\.topology\?\.localMachine/);
    assert.match(appScript.body, /function joinIpv4Addresses/);
    assert.match(appScript.body, /card\.classList\.add\('broker-card'\)/);
    assert.match(appScript.body, /SSH connection initiator/);
    assert.match(appScript.body, /SSH connection direction/);
    assert.match(appScript.body, /Broker port forward/);
    assert.doesNotMatch(appScript.body, /Use in browser config/);
    assert.match(appScript.body, /\? \{ label: 'Stop', onClick: \(\) => stopBrowser\(browser\) \}/);
    assert.match(appScript.body, /: \{ label: 'Start', onClick: \(\) => startBrowser\(browser\) \}/);
    assert.match(appScript.body, /\['session', browser\.sessionId[\s\S]*?\['proxy', browser\.proxyId[\s\S]*?\['app', browser\.appId/);
    assert.match(appScript.body, /arrow\.textContent = '↓'/);
    assert.match(appScript.body, /kind === 'session' && !browser\.sessionId/);
    assert.match(appScript.body, /browserConfigLabel\.className = 'browser-config-title-link entity-link mono'/);
    assert.doesNotMatch(appScript.body, /spawned from/);
    assert.match(appScript.body, /controls\.className = 'browser-diagram-controls'/);
    assert.doesNotMatch(appScript.body, /titleGroup\.append\(controls\);/);
    assert.doesNotMatch(appScript.body, /heading\.append\(titleInfo\);/);
    assert.match(appScript.body, /occupancyLabel\.className = 'browser-occupancy'/);
    assert.match(appScript.body, /titleInfo\.append\(titleGroup, occupancyLabel\)/);
    assert.match(appScript.body, /flowColumn\.className = 'browser-flow-column'/);
    assert.match(appScript.body, /content\.className = 'browser-diagram-content'/);
    assert.match(appScript.body, /details\.className = 'browser-diagram-details'/);
    assert.match(appScript.body, /content\.append\(details, preview\);/);
    assert.match(appScript.body, /preview\.className = 'browser-preview'/);
    assert.match(appScript.body, /function refreshBrowserPreviews/);
    assert.match(appScript.body, /function renderBrowserPreviewTabs/);
    assert.match(appScript.body, /\/api\/pwdev\/sessions\/\$\{encodeURIComponent\(browser\.sessionId\)\}\/pages/);
    assert.match(appScript.body, /browser-preview-dot/);
    assert.doesNotMatch(appScript.body, /setInterval\(\(\) => void refresh\(\)/);
    assert.match(appScript.body, /renderBrowsers\(snapshot\.browsers\);[\s\S]*?void refreshBrowserPreviews\(snapshot\.browsers\)/);
    assert.match(appScript.body, /openBrowserMonitor\(browser\)/);
    assert.match(appScript.body, /scroll\.className = 'table-scroll'/);
    const styles = await get(`${server.origin}/styles.css`);
    assert.equal(styles.statusCode, 200);
    assert.match(styles.body, /\.browser-node\.session\.inactive/);
    assert.match(styles.body, /\.layout\.nav-collapsed/);
    assert.match(styles.body, /\.nav-collapsed \.nav-links/);
    assert.match(styles.body, /border-style: dotted/);
    assert.match(styles.body, /flex-direction: column/);
    assert.match(styles.body, /align-items: flex-start/);
    assert.match(styles.body, /\.browser-flow-column/);
    assert.match(styles.body, /--browser-node-width: min\(100%, 260px\)/);
    assert.match(styles.body, /text-align: center/);
    assert.match(styles.body, /padding: 8px 14px/);
    assert.match(styles.body, /\.browser-diagram-title/);
    assert.match(styles.body, /\.browser-diagram-content/);
    assert.match(styles.body, /\.browser-preview-pages/);
    assert.match(styles.body, /\.browser-preview-dot\.selected/);
    assert.match(styles.body, /grid-template-columns: minmax\(240px, 34%\) minmax\(0, 1fr\)/);
    assert.match(styles.body, /\.browser-diagram-content[\s\S]*?gap: 12px/);
    assert.match(styles.body, /@container \(max-width: 680px\)[\s\S]*?\.browser-diagram-content[\s\S]*?grid-template-columns: 1fr/);
    assert.match(styles.body, /\.browser-preview/);
    assert.match(styles.body, /align-self: stretch/);
    assert.match(styles.body, /min-height: 300px/);
    assert.match(styles.body, /\.browser-preview img[\s\S]*?height: 100%/);
    assert.doesNotMatch(styles.body, /\.browser-preview-head/);
    assert.match(styles.body, /max-width: 100%/);
    assert.match(styles.body, /\.broker-card \.kv[\s\S]*?180px/);
    assert.match(appScript.body, /SSH peer IP addresses/);
    assert.match(appScript.body, /SSH peer OS \/ kernel/);

    const config = await getJson(`${server.origin}/api/config`);
    assert.equal(config.statusCode, 200);
    assert.equal(config.body.pwDevUrl, 'http://127.0.0.1:9696');

    const rejected = await postJson(`${server.origin}/api/pwdev/apps`, { id: 'nope' });
    assert.equal(rejected.statusCode, 405);
    assert.match(rejected.body.error, /read-only/);
  } finally {
    await server.close();
  }
});

test('gui registers document and monitor aliases only for its listening authority', async () => {
  const origins = [];
  const monitorHub = {
    addGuiOrigin: (origin) => origins.push(origin),
    stream: async (_browserId, _pageId, _req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end();
    },
    preview: async () => Buffer.from('preview'),
    action: async () => ({ ok: true }),
    close: async () => {},
  };
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub });
  const port = new URL(gui.origin).port;

  try {
    for (const document of ['/', '/index.html', '/api-docs', '/api-docs/', '/api-docs.html', '/monitor.html', '/monitor/example-browser']) {
      const count = origins.length;
      await request(`${gui.origin}${document}`, { method: 'GET', headers: { host: `localhost:${port}` } });
      assert.ok(origins.slice(count).includes(`http://localhost:${port}`), `${document} registers the served alias`);
    }
    await request(`${gui.origin}/api/monitor/example-browser/preview`, { method: 'GET', headers: { host: `localhost:${port}` } });
    await request(`${gui.origin}/api/monitor/example-browser/action`, {
      method: 'POST',
      body: JSON.stringify({ action: 'click', path: [1] }),
      headers: {
        'content-type': 'application/json',
        host: `localhost:${port}`,
        origin: `http://localhost:${port}`,
      },
    });
    await request(`${gui.origin}/api/monitor/example-browser/events`, { method: 'GET', headers: { host: `localhost:${port}` } });

    assert.equal(origins[0], gui.origin);
    const validOrigins = [...origins];
    for (const host of [`unrelated.test:${port}`, 'localhost:3000', `localhost:${port}@unrelated.test`, `localhost:${port}/spoof`]) {
      await request(`${gui.origin}/api/monitor/example-browser/preview`, { method: 'GET', headers: { host } });
      await request(`${gui.origin}/`, { method: 'GET', headers: { host } });
    }
    assert.deepEqual(origins, validOrigins, 'untrusted Host headers cannot mark other applications as the GUI');
  } finally {
    await gui.close();
  }
});

test('GUI documents register localhost after monitoring began through 127.0.0.1 without taking operator dialogs', async () => {
  const browserDouble = createMonitorBrowserDouble([
    { id: 'target', title: 'Target', url: 'http://localhost:3000/' },
  ]);
  const hub = createConnectedMonitorHub(browserDouble, 'mixed-host-session');
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub: hub });
  const alias = gui.origin.replace('127.0.0.1', 'localhost');
  try {
    assert.equal((await get(`${gui.origin}/api/monitor/mixed-host-browser/preview`)).body, 'target');
    const connection = hub.connections.get('mixed-host-browser');
    const operatorPages = [
      browserDouble.open({ id: 'ip-gui', title: 'GUI', url: `${gui.origin}/`, viewport: { width: 390, height: 844 } }),
      browserDouble.open({ id: 'alias-gui', title: 'GUI', url: `${alias}/`, viewport: { width: 390, height: 844 } }),
    ];
    await get(alias);
    let dismissals = 0;
    for (const page of operatorPages) page.emit('dialog', { dismiss: async () => { dismissals += 1; } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dismissals, 0, 'both GUI aliases keep their confirmations');
    assert.deepEqual((await hub.refreshPageInventory(connection)).map((page) => page.id), ['target']);
    for (const page of operatorPages) {
      assert.deepEqual(page.viewportSize(), { width: 390, height: 844 });
      assert.equal(page.listenerCount('load'), 0, 'GUI documents have no monitor telemetry observers');
      assert.equal(page.listenerCount('dialog'), 1, 'one inert listener suppresses Playwright auto-dismissal');
    }
    assert.equal(connection.pageId, 'target', 'the unrelated localhost application remains eligible');
  } finally {
    await gui.close();
  }
});

function staticMonitorHub(preview) {
  return {
    async stream(browserId, pageId, req, res) {
      res.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/event-stream; charset=utf-8',
      });
      res.write(`data: ${JSON.stringify({
        type: 'connected', browserId, sessionId: 'mobile-session', pageId: pageId ?? 'mobile-page',
        pages: [{ id: 'mobile-page', title: 'Mobile target', url: 'https://target.test/', lease: { owner: 'test-agent' } }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: 'page', browserId, url: 'https://target.test/', title: 'Mobile target',
        viewport: { width: 1920, height: 1080, devicePixelRatio: 1 }, scroll: { x: 0, y: 0 },
      })}\n\n`);
      req.once('close', () => res.end());
    },
    async preview() { return preview; },
    async action() { return { ok: true }; },
    async close() {},
  };
}

test('monitor clears stale Live state and pending screenshots after an established target becomes GUI-only', async () => {
  const browser = await chromium.launch({ headless: true });
  const seedPage = await browser.newPage({ viewport: { width: 160, height: 90 } });
  const preview = await seedPage.screenshot({ type: 'jpeg' });
  const browserDouble = createMonitorBrowserDouble([
    { id: 'target', title: 'Target', url: 'https://target.test/' },
  ]);
  browserDouble.page('target').screenshot = async () => preview;
  const hub = createConnectedMonitorHub(browserDouble, 'no-target-session');
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub: hub });
  let previewRequests = 0;
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const nativeDecode = HTMLImageElement.prototype.decode;
      const nativeRevoke = URL.revokeObjectURL;
      window.__revokedUrls = [];
      URL.revokeObjectURL = (url) => { window.__revokedUrls.push(url); nativeRevoke(url); };
      HTMLImageElement.prototype.decode = function () {
        if (!window.__holdDecode) return nativeDecode.call(this);
        window.__pendingDecodeUrl = this.src;
        return new Promise((resolve, reject) => {
          window.__releaseDecode = () => nativeDecode.call(this).then(resolve, reject);
        });
      };
    });
    page.on('request', (request) => {
      if (request.url().includes('/preview')) previewRequests += 1;
    });
    await page.goto(`${gui.origin}/monitor/no-target-browser?pageId=target`);
    await page.waitForFunction(() => document.querySelector('#mirror-image').naturalWidth > 0);
    const oldUrl = await page.locator('#mirror-image').getAttribute('src');
    assert.equal(await page.locator('#monitor-status').textContent(), 'Live');
    await page.evaluate(() => { window.__holdDecode = true; });
    await page.locator('#refresh-screenshot').click();
    await page.waitForFunction(() => window.__releaseDecode);
    const pendingUrl = await page.evaluate(() => window.__pendingDecodeUrl);
    const connection = hub.connections.get('no-target-browser:target');
    browserDouble.page('target').navigateTo(`${gui.origin}/`);
    await hub.refresh(connection);
    await page.waitForFunction(() => !document.querySelector('#monitor-status').classList.contains('good'), null, { timeout: 2000 });
    assert.equal(await page.locator('#monitor-status').textContent(), 'No target page');
    assert.equal(await page.locator('#mirror-image').getAttribute('src'), null);
    assert.equal(await page.locator('#mirror-image').isVisible(), false, 'the vanished screenshot does not leave a broken image');
    assert.equal(await page.locator('.page-dot, .page-picker').count(), 0);
    assert.equal(await page.locator('#nav-target-url').getAttribute('href'), null);
    assert.doesNotMatch(await page.locator('#page-meta').textContent(), /target\.test/);
    assert.match(await page.locator('#mirror-empty').textContent(), /open a target page/i);
    assert.equal(await page.locator('#mirror-empty').isVisible(), true);
    for (const id of ['refresh-screenshot', 'nav-back', 'nav-forward', 'nav-reload']) {
      assert.equal(await page.locator(`#${id}`).isDisabled(), true);
    }
    assert.equal(await page.locator('#mirror-frame-wrap').getAttribute('aria-disabled'), 'true');
    await page.evaluate(() => window.__releaseDecode());
    await page.waitForFunction((url) => window.__revokedUrls.includes(url), pendingUrl);
    assert.equal(await page.locator('#mirror-image').getAttribute('src'), null, 'late decode cannot restore the vanished target');
    assert.ok(await page.evaluate((url) => window.__revokedUrls.includes(url), oldUrl));
    const requestsAfterLoss = previewRequests;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(previewRequests, requestsAfterLoss, 'screenshot polling stops without a target');
    await waitFor(() => connection.subscribers.size === 0);
    assert.equal(hub.connections.size, 0);
  } finally {
    await browser.close();
    await gui.close();
  }
});

test('monitor stays compact on mobile and loads all same-origin assets', async () => {
  const browser = await chromium.launch({ headless: true });
  const seedPage = await browser.newPage({ viewport: { width: 160, height: 90 } });
  const preview = await seedPage.screenshot({ type: 'jpeg' });
  const hub = staticMonitorHub(preview);
  const stream = hub.stream;
  let events;
  hub.stream = (...args) => { events = args[3]; return stream(...args); };
  const actions = [];
  hub.action = async (_browserId, _pageId, payload) => { actions.push(payload); return { ok: true }; };
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub: hub });
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
    const issues = [];
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const header = await page.locator('.monitor-topbar').boundingBox();
      const controls = await page.locator('.browser-controls').boundingBox();
      const address = await page.locator('.browser-address').boundingBox();
      const wrap = await page.locator('#mirror-frame-wrap').boundingBox();
      if (header.height >= 150) issues.push(`${width}px header is ${header.height}px tall`);
      if (Math.abs(controls.y - address.y) >= 12) issues.push(`${width}px toolbar stacks its address`);
      if (wrap.height >= 300) issues.push(`${width}px mirror reserves ${wrap.height}px height`);
      assert.ok(address.width > 90, 'the address remains usable beside navigation');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const box = await page.locator('#mirror-image').boundingBox();
      const previousDowns = actions.filter((action) => action.type === 'down').length;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await waitFor(() => actions.filter((action) => action.type === 'down').length === previousDowns + 1);
      const pointerDown = actions.filter((action) => action.type === 'down').at(-1);
      assert.ok(Math.abs(pointerDown.x - 960) < 1);
      assert.ok(Math.abs(pointerDown.y - 540) < 1);
      // Measure the painted 16:9 content inside the image's one-pixel border.
      const paintedWidth = Math.min(box.width - 2, (box.height - 2) * 16 / 9);
      await page.mouse.click(box.x + box.width / 2 - paintedWidth / 4, box.y + box.height / 2 + paintedWidth * 9 / 64);
      await waitFor(() => actions.filter((action) => action.type === 'down').length === previousDowns + 2);
      const quarterClick = actions.filter((action) => action.type === 'down').at(-1);
      assert.ok(Math.abs(quarterClick.x - 480) < 5, 'quarter-width click maps into the remote 1920px viewport');
      assert.ok(Math.abs(quarterClick.y - 810) < 5, 'three-quarter-height click excludes letterbox space');
    }
    const icon = await page.locator('link[rel="icon"]').getAttribute('href', { timeout: 1000 }).catch(() => null);
    if (icon !== '/favicon.svg') issues.push('monitor has no explicit SVG favicon');
    if (icon) assert.equal(await page.evaluate(async (url) => (await fetch(url)).status, icon), 200);
    if (await page.locator('#monitor-status').getAttribute('role') !== 'status') issues.push('live status role missing');
    if (await page.locator('#monitor-status').getAttribute('aria-live') !== 'polite') issues.push('polite status announcement missing');
    assert.equal(await page.locator('#monitor-status').textContent(), 'Live');
    events.write(`data: ${JSON.stringify({ type: 'disconnected' })}\n\n`);
    await page.waitForFunction(() => document.querySelector('#monitor-status').textContent === 'Browser disconnected');
    await page.setViewportSize({ width: 1440, height: 900 });
    const desktop = await page.locator('#mirror-frame-wrap').boundingBox();
    assert.ok(desktop.height >= 600 && desktop.height <= 710, `desktop mirror should use available height, got ${desktop.height}`);
    assert.deepEqual(issues, []);
    assert.deepEqual(failures, []);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await gui.close();
  }
});

test('monitor keeps its decoded screenshot through pending decode and capture failures', async () => {
  const browser = await chromium.launch({ headless: true });
  const seedPage = await browser.newPage({ viewport: { width: 160, height: 90 } });
  const firstPreview = await seedPage.screenshot({ type: 'jpeg' });
  await seedPage.setViewportSize({ width: 120, height: 90 });
  const secondPreview = await seedPage.screenshot({ type: 'jpeg' });
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub: staticMonitorHub(firstPreview) });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.addInitScript(() => {
      const nativeDecode = HTMLImageElement.prototype.decode;
      const nativeRevoke = URL.revokeObjectURL;
      window.__revokedUrls = [];
      URL.revokeObjectURL = (url) => { window.__revokedUrls.push(url); nativeRevoke(url); };
      HTMLImageElement.prototype.decode = function () {
        if (!window.__holdDecode) return nativeDecode.call(this);
        return new Promise((resolve, reject) => {
          window.__pendingDecodeUrl = this.src;
          window.__releaseDecode = () => nativeDecode.call(this).then(resolve, reject);
          window.__rejectDecode = () => reject(new Error('test decode failure'));
        });
      };
    });
    await page.goto(`${gui.origin}/monitor/mobile-browser?pageId=mobile-page`);
    await page.waitForFunction(() => document.querySelector('#mirror-image')?.naturalWidth > 0);
    const mirror = page.locator('#mirror-image');
    const firstSrc = await mirror.getAttribute('src');
    await page.evaluate(() => { window.__holdDecode = true; });
    await page.route('**/api/monitor/*/preview*', (route) => route.fulfill({ contentType: 'image/jpeg', body: secondPreview }));
    await page.locator('#refresh-screenshot').click();
    await page.waitForFunction(() => window.__releaseDecode || !document.querySelector('#refresh-screenshot').disabled);
    assert.equal(await mirror.getAttribute('src'), firstSrc, 'retain the current screenshot while the next image decodes');
    assert.equal(await page.locator('#mirror-frame-wrap').evaluate((element) => element.style.getPropertyValue('--mirror-aspect')), '160 / 90');
    assert.deepEqual(await page.evaluate(() => window.__revokedUrls), []);
    await page.evaluate(() => window.__releaseDecode());
    await page.waitForFunction((previous) => document.querySelector('#mirror-image').src !== previous && !document.querySelector('#refresh-screenshot').disabled, firstSrc);
    const secondSrc = await mirror.getAttribute('src');
    assert.equal(await page.locator('#mirror-frame-wrap').evaluate((element) => element.style.getPropertyValue('--mirror-aspect')), '120 / 90');
    assert.ok(await page.evaluate((url) => window.__revokedUrls.includes(url), firstSrc));

    await page.evaluate(() => { window.__pendingDecodeUrl = undefined; });
    await page.locator('#refresh-screenshot').click();
    await page.waitForFunction(() => window.__pendingDecodeUrl);
    const rejectedUrl = await page.evaluate(() => window.__pendingDecodeUrl);
    await page.evaluate(() => window.__rejectDecode());
    await page.waitForFunction(() => !document.querySelector('#refresh-screenshot').disabled);
    assert.equal(await mirror.getAttribute('src'), secondSrc, 'decode failure retains the last good screenshot');
    assert.ok(await page.evaluate((url) => window.__revokedUrls.includes(url), rejectedUrl));
    await page.route('**/api/monitor/*/preview*', (route) => route.fulfill({ status: 503, body: 'capture unavailable' }));
    await page.locator('#refresh-screenshot').click();
    await page.waitForFunction(() => !document.querySelector('#refresh-screenshot').disabled);
    assert.equal(await mirror.getAttribute('src'), secondSrc, 'capture failure retains the last good screenshot');
    assert.equal(await mirror.evaluate((element) => element.complete && element.naturalWidth > 0), true);
    assert.equal(await page.locator('#mirror-empty').isVisible(), false);
    assert.equal(await page.evaluate((url) => window.__revokedUrls.includes(url), secondSrc), false);
    await page.evaluate(() => { window.__holdDecode = false; });
    await page.route('**/api/monitor/*/preview*', (route) => route.fulfill({ contentType: 'image/jpeg', body: firstPreview }));
    await page.locator('#refresh-screenshot').click();
    await page.waitForFunction((previous) => document.querySelector('#mirror-image').src !== previous, secondSrc);
    assert.equal(await page.locator('#mirror-frame-wrap').evaluate((element) => element.style.getPropertyValue('--mirror-aspect')), '160 / 90');
  } finally {
    await browser.close();
    await gui.close();
  }
});

test('monitor and dashboard tab dots retain small indicators within larger touch targets', async () => {
  const browser = await chromium.launch({ headless: true });
  const seedPage = await browser.newPage({ viewport: { width: 160, height: 90 } });
  const preview = await seedPage.screenshot({ type: 'jpeg' });
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub: staticMonitorHub(preview) });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${gui.origin}/monitor/mobile-browser?pageId=mobile-page`);
    await page.locator('.page-dot').waitFor();
    const monitorDot = await page.locator('.page-dot').evaluate(tabDotGeometry);
    await routeDashboardSnapshot(page, browserPreviewSnapshot());
    await page.route('**/api/pwdev/sessions/preview-session/pages', (route) => route.fulfill({
      contentType: 'application/json', body: JSON.stringify({ ok: true, sessionId: 'preview-session', pages: [
        { id: 'preview-page', type: 'page', title: 'Preview', url: 'https://preview.test/', lease: { owner: 'test-agent' } },
        { id: 'other-page', type: 'page', title: 'Other', url: 'https://preview.test/other' },
      ] }),
    }));
    await page.route('**/api/monitor/preview-browser/preview*', (route) => route.fulfill({ contentType: 'image/jpeg', body: preview }));
    await page.goto(gui.origin);
    await page.locator('.browser-preview-dot.selected').waitFor();
    await page.locator('.browser-preview-dot.selected').scrollIntoViewIfNeeded();
    const dashboardDot = await page.locator('.browser-preview-dot.selected').evaluate(tabDotGeometry);
    for (const [name, dot] of [['monitor', monitorDot], ['dashboard', dashboardDot]]) {
      assert.ok(dot.width >= 28 && dot.height >= 28, `${name} dot needs a 28px touch target, got ${dot.width}×${dot.height}`);
      assert.ok(dot.indicatorWidth <= 12 && dot.indicatorWidth > 0, `${name} indicator stays small`);
      assert.notEqual(dot.background, 'rgba(0, 0, 0, 0)', `${name} selected indicator is filled`);
      assert.notEqual(dot.shadow, 'none', `${name} leased indicator has a ring`);
      assert.equal(dot.outerHit, true, `${name} touch target includes space outside the indicator`);
    }
  } finally {
    await browser.close();
    await gui.close();
  }
});

function tabDotGeometry(element) {
  const box = element.getBoundingClientRect();
  const style = getComputedStyle(element, '::before');
  return {
    width: box.width, height: box.height, indicatorWidth: parseFloat(style.width),
    background: style.backgroundColor, shadow: style.boxShadow,
    outerHit: document.elementFromPoint(box.x + 2, box.y + box.height / 2) === element,
  };
}

test('screenshot monitor forwards mapped mouse, keyboard, and paste input', async () => {
  const browser = await chromium.launch({ headless: true });
  const seedPage = await browser.newPage({ viewport: { width: 160, height: 90 } });
  await seedPage.setContent('<body style="margin:0;background:#fff"></body>');
  const preview = await seedPage.screenshot({ type: 'jpeg' });
  const actions = [];
  const monitorHub = {
    async stream(browserId, pageId, req, res) {
      res.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/event-stream; charset=utf-8',
      });
      res.write(`data: ${JSON.stringify({
        type: 'connected',
        browserId,
        sessionId: 'input-session',
        pageId: pageId ?? 'input-page',
        pages: [{ id: 'input-page', title: 'Input target', url: 'https://target.test/' }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: 'page',
        browserId,
        url: 'https://target.test/',
        title: 'Input target',
        viewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
        scroll: { x: 0, y: 0 },
      })}\n\n`);
      req.once('close', () => res.end());
    },
    async preview() { return preview; },
    async action(_browserId, _pageId, payload) {
      actions.push(payload);
      return { ok: true, action: payload.action, type: payload.type };
    },
    async close() {},
  };
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: gui.origin });
    await page.goto(`${gui.origin}/monitor/input-browser?pageId=input-page`);
    const mirror = page.locator('#mirror-image');
    await mirror.waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const image = document.querySelector('#mirror-image');
      return image?.complete && image.naturalWidth > 0;
    });

    assert.equal(await page.locator('.monitor-topbar #nav-back').count(), 0);
    await page.locator('.browser-toolbar #nav-back').click();
    await page.locator('#nav-forward').click();
    await page.locator('#nav-reload').click();

    const box = await mirror.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 8);
    await page.mouse.up();
    await page.mouse.wheel(0, 120);
    await page.keyboard.type('Hi');
    await page.evaluate(() => navigator.clipboard.writeText(' pasted'));
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
    await page.locator('#mirror-frame-wrap').evaluate((element) => {
      element.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }));
      element.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true, cancelable: true,
      }));
    });
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowLeft');

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 20, box.y + box.height / 2);
    await page.mouse.up();

    await page.locator('#mirror-frame-wrap').evaluate((element, point) => {
      element.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: point.x,
        clientY: point.y,
        deltaY: 3,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
      }));
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });

    await waitFor(() => actions.some((action) => action.action === 'keyboard' && action.type === 'insertText'));
    await waitFor(() => actions.filter((action) => action.action === 'navigation').length === 3);
    await waitFor(() => actions.some((action) => action.action === 'pointer' && action.type === 'up' && action.x < 1));
    await waitFor(() => actions.some((action) => action.action === 'pointer' && action.type === 'wheel' && action.deltaY === 48));
    const pointerDown = actions.find((action) => action.action === 'pointer' && action.type === 'down');
    assert.ok(Math.abs(pointerDown.x - 960) < 1);
    assert.ok(Math.abs(pointerDown.y - 540) < 1);
    assert.equal(actions.some((action) => action.action === 'pointer' && action.type === 'up'), true);
    assert.equal(actions.some((action) => action.action === 'pointer' && action.type === 'wheel' && action.deltaY === 120), true);
    assert.equal(actions.some((action) => action.action === 'keyboard' && action.type === 'down'), true);
    assert.equal(actions.some((action) => action.action === 'keyboard' && action.type === 'up'), true);
    assert.equal(actions.some((action) => action.action === 'keyboard' && action.type === 'insertText' && action.text === ' pasted'), true);
    assert.equal(actions.some((action) => action.action === 'keyboard' && action.type === 'up' && action.key === 'v'), false);
    assert.equal(actions.some((action) => action.action === 'keyboard' && action.type === 'down' && action.key === 'Enter'), true);
    assert.equal(actions.some((action) => action.action === 'keyboard' && action.type === 'down' && action.key === 'ArrowLeft'), true);
    assert.deepEqual(
      actions.filter((action) => action.action === 'navigation').map((action) => action.type),
      ['back', 'forward', 'reload'],
    );
    const pointerUps = actions.filter((action) => action.action === 'pointer' && action.type === 'up');
    assert.ok(pointerUps.at(-1).x < 1, 'an outside drag should release at the viewport edge');
    assert.equal(actions.some((action) => action.action === 'pointer' && action.type === 'wheel' && action.deltaY === 48), true);
  } finally {
    await browser.close();
    await gui.close();
  }
});

test('screenshot monitor bounds queued pointer moves while an action is slow', async () => {
  const browser = await chromium.launch({ headless: true });
  const seedPage = await browser.newPage({ viewport: { width: 160, height: 90 } });
  await seedPage.setContent('<body style="margin:0;background:#fff"></body>');
  const preview = await seedPage.screenshot({ type: 'jpeg' });
  const actions = [];
  let releaseFirstMove;
  const monitorHub = {
    async stream(browserId, pageId, req, res) {
      res.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/event-stream; charset=utf-8' });
      res.write(`data: ${JSON.stringify({ type: 'connected', browserId, sessionId: 'slow-session', pageId, pages: [] })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'page', browserId, viewport: { width: 1920, height: 1080, devicePixelRatio: 1 } })}\n\n`);
      req.once('close', () => res.end());
    },
    async preview() { return preview; },
    async action(_browserId, _pageId, payload) {
      actions.push(payload);
      if (payload.action === 'pointer' && payload.type === 'move' && !releaseFirstMove) {
        await new Promise((resolve) => { releaseFirstMove = resolve; });
      }
      return { ok: true };
    },
    async close() {},
  };
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${gui.origin}/monitor/slow-browser?pageId=slow-page`);
    const mirror = page.locator('#mirror-image');
    await mirror.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#mirror-image')?.naturalWidth > 0);
    const box = await mirror.boundingBox();

    await page.mouse.move(box.x + 100, box.y + 100);
    await waitFor(() => Boolean(releaseFirstMove));
    for (let offset = 0; offset < 8; offset += 1) {
      await page.mouse.move(box.x + 110 + offset * 5, box.y + 110 + offset * 3);
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    await page.mouse.down();
    releaseFirstMove();

    await waitFor(() => actions.some((action) => action.action === 'pointer' && action.type === 'down'));
    const moves = actions.filter((action) => action.action === 'pointer' && action.type === 'move');
    assert.equal(moves.length, 2, 'only the in-flight and latest queued move should be sent');
    assert.deepEqual(actions.slice(-2).map((action) => action.type), ['move', 'down']);
  } finally {
    await browser.close();
    await gui.close();
  }
});

test('screenshot monitor keeps an input failure visible across later input', async () => {
  const browser = await chromium.launch({ headless: true });
  const seedPage = await browser.newPage({ viewport: { width: 160, height: 90 } });
  const preview = await seedPage.screenshot({ type: 'jpeg' });
  let attempts = 0;
  const monitorHub = {
    async stream(browserId, pageId, req, res) {
      res.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/event-stream; charset=utf-8' });
      res.write(`data: ${JSON.stringify({ type: 'connected', browserId, sessionId: 'error-session', pageId, pages: [] })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'page', browserId, viewport: { width: 1920, height: 1080, devicePixelRatio: 1 } })}\n\n`);
      req.once('close', () => res.end());
    },
    async preview() { return preview; },
    async action() {
      attempts += 1;
      return attempts === 1 ? { ok: false, error: 'remote input unavailable' } : { ok: true };
    },
    async close() {},
  };
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${gui.origin}/monitor/error-browser?pageId=error-page`);
    await page.locator('#mirror-frame-wrap').focus();
    await page.keyboard.press('a');
    await page.waitForFunction(() => document.querySelector('#input-meta')?.textContent?.includes('remote input unavailable'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(await page.locator('#input-meta').textContent(), /remote input unavailable/);
  } finally {
    await browser.close();
    await gui.close();
  }
});

for (const operatorHost of ['127.0.0.1', 'localhost']) {
test(`dashboard previews exclude mixed-host GUI tabs when opened through ${operatorHost}`, async () => {
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
        { id: 'alternate-gui', title: 'Alias GUI', url: `${gui.origin.replace('127.0.0.1', 'localhost')}/` },
        { id: 'target', title: 'Target', url: 'http://127.0.0.1:3000/' },
        { id: 'monitor', title: 'Monitor', url: `${gui.origin}/monitor/preview-browser` },
      ] }),
    }));
    await page.route('**/api/monitor/preview-browser/preview*', (route) => {
      previewRequests += 1;
      assert.match(route.request().url(), /pageId=target/);
      return route.fulfill({ contentType: 'image/jpeg', body: preview });
    });
    await page.goto(gui.origin.replace('127.0.0.1', operatorHost));
    await page.waitForFunction(() => {
      const image = document.querySelector('.browser-preview img');
      return image?.complete && image.naturalWidth > 0;
    }, null, { timeout: 2000 });
    assert.equal(await page.locator('.browser-preview-dot').count(), 0);
    assert.equal(previewRequests, 1);
    assert.doesNotMatch(await page.locator('.browser-preview').textContent(), /pw-dev|Monitor/);
  } finally {
    await browser.close();
    await gui.close();
  }
});
}

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
    assert.equal(await page.getByRole('button', { name: 'Monitor' }).count(), 0);
  } finally {
    await browser.close();
    await gui.close();
  }
});

test('browser thumbnail clears when the remaining session tabs are GUI-only', async () => {
  const browser = await chromium.launch({ headless: true });
  const seedPage = await browser.newPage({ viewport: { width: 160, height: 90 } });
  await seedPage.setContent('<body style="margin:0;background:#36c"></body>');
  const preview = await seedPage.screenshot({ type: 'jpeg' });
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub: { async close() {} } });
  let guiOnly = false;
  let previewRequests = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await routeDashboardSnapshot(page, browserPreviewSnapshot());
    await page.route('**/api/pwdev/sessions/preview-session/pages', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ pages: guiOnly
        ? [{ id: 'dashboard', title: 'pw-dev', url: `${gui.origin}/` }]
        : [{ id: 'target', title: 'Target', url: 'http://127.0.0.1:3000/' }],
      }),
    }));
    await page.route('**/api/monitor/preview-browser/preview*', (route) => {
      previewRequests += 1;
      return route.fulfill({ contentType: 'image/jpeg', body: preview });
    });

    await page.goto(gui.origin);
    await page.locator('.browser-preview img').waitFor({ state: 'visible' });
    guiOnly = true;
    await page.locator('#refresh').click();
    await page.getByText('Open a target page to load a preview.').waitFor();
    assert.equal(await page.locator('.browser-preview img').count(), 0);
    assert.equal(previewRequests, 1);
    assert.equal(await page.getByRole('button', { name: 'Monitor' }).count(), 0);
  } finally {
    await browser.close();
    await gui.close();
  }
});

test('dashboard stale preview controls cannot open an unscoped monitor while another preview is pending', async () => {
  const browser = await chromium.launch({ headless: true });
  const seedPage = await browser.newPage({ viewport: { width: 160, height: 90 } });
  await seedPage.setContent('<body style="margin:0;background:#36c"></body>');
  const preview = await seedPage.screenshot({ type: 'jpeg' });
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub: { async close() {} } });
  const snapshot = browserPreviewSnapshot();
  snapshot.server.sessions.body.sessions.push({
    sessionId: 'pending-session',
    browserId: 'pending-browser',
    browserConfigId: 'preview-config',
    scope: 'default',
  });
  snapshot.server.browsers.body.browsers.push({
    id: 'pending-browser',
    name: 'Pending browser',
    browserConfigId: 'preview-config',
    sessionId: 'pending-session',
    status: 'occupied',
    occupancy: { state: 'unclaimed' },
  });
  let previewGuiOnly = false;
  let holdPendingPages = false;
  let releasePendingPages;
  let pendingPagesStarted;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.addInitScript(() => {
      const nativeRevokeObjectUrl = URL.revokeObjectURL.bind(URL);
      window.__revokedObjectUrls = [];
      URL.revokeObjectURL = (url) => {
        window.__revokedObjectUrls.push(url);
        nativeRevokeObjectUrl(url);
      };
      window.__monitorOpens = [];
      window.open = (url) => { window.__monitorOpens.push(url); };
    });
    await routeDashboardSnapshot(page, snapshot);
    await page.route('**/api/pwdev/sessions/*/pages', async (route) => {
      const sessionId = new URL(route.request().url()).pathname.split('/').at(-2);
      if (sessionId === 'pending-session' && holdPendingPages) {
        pendingPagesStarted();
        await new Promise((resolve) => { releasePendingPages = resolve; });
      }
      const pages = sessionId === 'preview-session'
        ? previewGuiOnly
          ? [{ id: 'dashboard', title: 'pw-dev', url: `${gui.origin}/` }]
          : [{ id: 'target', title: 'Target', url: 'http://127.0.0.1:3000/' }]
        : [{ id: 'pending-target', title: 'Pending target', url: 'http://127.0.0.1:3001/' }];
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ pages }) });
    });
    await page.route('**/api/monitor/*/preview*', (route) => route.fulfill({
      contentType: 'image/jpeg',
      body: preview,
    }));

    await page.goto(gui.origin);
    await page.waitForFunction(() => document.querySelectorAll('.browser-preview img').length === 2);
    const previewCard = page.locator('.browser-diagram').filter({ hasText: 'Preview browser' });
    const stalePreviewUrl = await previewCard.locator('.browser-preview img').getAttribute('src');
    assert.equal(await previewCard.getByRole('button', { name: 'Monitor' }).count(), 1);
    assert.equal(await previewCard.locator('.browser-preview-media').count(), 1);

    previewGuiOnly = true;
    holdPendingPages = true;
    const pendingStarted = new Promise((resolve) => { pendingPagesStarted = resolve; });
    await page.locator('#refresh').click();
    await pendingStarted;
    await page.waitForFunction(
      (url) => window.__revokedObjectUrls.includes(url),
      stalePreviewUrl,
    );

    await previewCard.getByRole('button', { name: 'Monitor' }).click();
    await previewCard.locator('.browser-preview-media').click();
    assert.deepEqual(await page.evaluate(() => window.__monitorOpens), []);
  } finally {
    releasePendingPages?.();
    await browser.close();
    await gui.close();
  }
});

test('browser thumbnail replaces decoded images without a blank frame', async () => {
  const browser = await chromium.launch({ headless: true });
  const seedPage = await browser.newPage({ viewport: { width: 160, height: 90 } });
  await seedPage.setContent('<body style="margin:0;background:#d33"></body>');
  const firstPreview = await seedPage.screenshot({ type: 'jpeg' });
  await seedPage.setContent('<body style="margin:0;background:#36c"></body>');
  const secondPreview = await seedPage.screenshot({ type: 'jpeg' });
  const gui = await startPwDevGuiServer({
    port: 0,
    brokerDiscovery: false,
    monitorHub: { async close() {} },
  });
  let previewRequests = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.addInitScript(() => {
      const nativeDecode = HTMLImageElement.prototype.decode;
      let previewDecodeCount = 0;
      HTMLImageElement.prototype.decode = function decodePreview() {
        previewDecodeCount += 1;
        window.__previewDecodeCount = previewDecodeCount;
        if (previewDecodeCount === 1) return nativeDecode.call(this);
        return new Promise((resolve, reject) => {
          window.__releasePreviewDecode = () => nativeDecode.call(this).then(resolve, reject);
          window.__rejectPreviewDecode = () => reject(new Error('synthetic decode failure'));
        });
      };
    });
    await page.route('**/api/config', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, pwDevUrl: 'http://pw-dev.test', brokerUrl: 'http://broker.test', proxyManagerUrl: 'http://proxy.test' }),
    }));
    await page.route('**/api/snapshot', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(browserPreviewSnapshot()),
    }));
    await page.route('**/api/pwdev/sessions/preview-session/pages', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, sessionId: 'preview-session', pages: [{ id: 'preview-page', type: 'page', title: 'Preview', url: 'https://preview.test/' }] }),
    }));
    await page.route('**/api/monitor/preview-browser/preview*', (route) => {
      previewRequests += 1;
      return route.fulfill({
        contentType: 'image/jpeg',
        body: previewRequests === 1 ? firstPreview : secondPreview,
      });
    });

    await page.goto(gui.origin);
    const thumbnail = page.locator('.browser-preview img');
    await thumbnail.waitFor({ state: 'visible' });
    const firstSrc = await thumbnail.getAttribute('src');

    await page.locator('#refresh').click();
    await waitFor(() => previewRequests === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(await thumbnail.getAttribute('src'), firstSrc, 'the decoded thumbnail should remain visible during replacement decoding');
    assert.equal(
      await thumbnail.evaluate((image) => getComputedStyle(image).animationName),
      'none',
      're-rendering the unchanged thumbnail should not replay its fade',
    );
    await page.evaluate(() => window.__releasePreviewDecode());
    await page.waitForFunction((previousSrc) => document.querySelector('.browser-preview img')?.getAttribute('src') !== previousSrc, firstSrc);
    assert.deepEqual(
      await thumbnail.evaluate((image) => {
        const style = getComputedStyle(image);
        return { animationName: style.animationName, animationDuration: style.animationDuration };
      }),
      { animationName: 'browser-preview-fade', animationDuration: '0.15s' },
    );

    const decodedSrc = await thumbnail.getAttribute('src');
    await page.locator('#refresh').click();
    await waitFor(() => previewRequests === 3);
    await page.waitForFunction(() => window.__previewDecodeCount === 3);
    await page.evaluate(() => window.__rejectPreviewDecode());
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await thumbnail.getAttribute('src'), decodedSrc, 'a failed decode should retain the previous thumbnail');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('#refresh').click();
    await waitFor(() => previewRequests === 4);
    await page.waitForFunction(() => window.__previewDecodeCount === 4);
    await page.evaluate(() => window.__releasePreviewDecode());
    await page.waitForFunction((previousSrc) => document.querySelector('.browser-preview img')?.getAttribute('src') !== previousSrc, decodedSrc);
    assert.equal(
      await thumbnail.evaluate((image) => getComputedStyle(image).animationName),
      'none',
      'reduced-motion users should not receive the thumbnail fade',
    );
  } finally {
    await browser.close();
    await gui.close();
  }
});

test('browser thumbnail ignores an older decode that finishes after a newer refresh', async () => {
  const browser = await chromium.launch({ headless: true });
  const seedPage = await browser.newPage({ viewport: { width: 160, height: 90 } });
  const previews = [];
  for (const color of ['#d33', '#db3', '#36c']) {
    await seedPage.setContent(`<body style="margin:0;background:${color}"></body>`);
    previews.push(await seedPage.screenshot({ type: 'jpeg' }));
  }
  const gui = await startPwDevGuiServer({
    port: 0,
    brokerDiscovery: false,
    monitorHub: { async close() {} },
  });
  let previewRequests = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.addInitScript(() => {
      const nativeDecode = HTMLImageElement.prototype.decode;
      let previewDecodeCount = 0;
      HTMLImageElement.prototype.decode = function decodePreview() {
        previewDecodeCount += 1;
        if (previewDecodeCount !== 2) return nativeDecode.call(this);
        return new Promise((resolve, reject) => {
          window.__releaseOlderPreviewDecode = () => nativeDecode.call(this).then(resolve, reject);
        });
      };
    });
    await page.route('**/api/config', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, pwDevUrl: 'http://pw-dev.test', brokerUrl: 'http://broker.test', proxyManagerUrl: 'http://proxy.test' }),
    }));
    await page.route('**/api/snapshot', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(browserPreviewSnapshot()),
    }));
    await page.route('**/api/pwdev/sessions/preview-session/pages', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, sessionId: 'preview-session', pages: [{ id: 'preview-page', type: 'page', title: 'Preview', url: 'https://preview.test/' }] }),
    }));
    await page.route('**/api/monitor/preview-browser/preview*', (route) => {
      const preview = previews[Math.min(previewRequests, previews.length - 1)];
      previewRequests += 1;
      return route.fulfill({ contentType: 'image/jpeg', body: preview });
    });

    await page.goto(gui.origin);
    const thumbnail = page.locator('.browser-preview img');
    await thumbnail.waitFor({ state: 'visible' });
    const firstSrc = await thumbnail.getAttribute('src');

    await page.locator('#refresh').click();
    await waitFor(() => previewRequests === 2);
    await page.locator('#refresh').click();
    await waitFor(() => previewRequests === 3);
    await page.waitForFunction((previousSrc) => document.querySelector('.browser-preview img')?.getAttribute('src') !== previousSrc, firstSrc);
    const newestSrc = await thumbnail.getAttribute('src');

    await page.evaluate(() => window.__releaseOlderPreviewDecode());
    await new Promise((resolve) => setTimeout(resolve, 100));
    await page.locator('[data-browser-view="table"]').click();
    await page.locator('[data-browser-view="diagram"]').click();
    assert.equal(await thumbnail.getAttribute('src'), newestSrc, 'an obsolete decode must not replace the latest thumbnail');
  } finally {
    await browser.close();
    await gui.close();
  }
});

test('browser thumbnail discards an initial preview if the browser stops before decode', async () => {
  const browser = await chromium.launch({ headless: true });
  const seedPage = await browser.newPage({ viewport: { width: 160, height: 90 } });
  await seedPage.setContent('<body style="margin:0;background:#36c"></body>');
  const preview = await seedPage.screenshot({ type: 'jpeg' });
  const gui = await startPwDevGuiServer({
    port: 0,
    brokerDiscovery: false,
    monitorHub: { async close() {} },
  });
  let running = true;
  let previewRequests = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.addInitScript(() => {
      const nativeDecode = HTMLImageElement.prototype.decode;
      let previewDecodeCount = 0;
      HTMLImageElement.prototype.decode = function decodePreview() {
        previewDecodeCount += 1;
        window.__previewDecodeCount = previewDecodeCount;
        return new Promise((resolve, reject) => {
          window.__releasePreviewDecode = () => nativeDecode.call(this).then(resolve, reject);
        });
      };
    });
    await page.route('**/api/config', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, pwDevUrl: 'http://pw-dev.test', brokerUrl: 'http://broker.test', proxyManagerUrl: 'http://proxy.test' }),
    }));
    await page.route('**/api/snapshot', (route) => {
      const snapshot = browserPreviewSnapshot();
      if (!running) {
        snapshot.server.sessions.body.sessions = [];
        delete snapshot.server.browsers.body.browsers[0].sessionId;
        snapshot.server.browsers.body.browsers[0].status = 'ready';
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(snapshot) });
    });
    await page.route('**/api/pwdev/sessions/preview-session/pages', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, sessionId: 'preview-session', pages: [{ id: 'preview-page', type: 'page', title: 'Preview', url: 'https://preview.test/' }] }),
    }));
    await page.route('**/api/monitor/preview-browser/preview*', (route) => {
      previewRequests += 1;
      return route.fulfill({ contentType: 'image/jpeg', body: preview });
    });

    await page.goto(gui.origin);
    await waitFor(() => previewRequests === 1);
    await page.waitForFunction(() => window.__previewDecodeCount === 1);

    running = false;
    await page.locator('#refresh').click();
    await page.getByText('Start the browser to load a preview.').waitFor();
    await page.evaluate(() => window.__releasePreviewDecode());
    await new Promise((resolve) => setTimeout(resolve, 100));

    running = true;
    await page.locator('#refresh').click();
    await waitFor(() => previewRequests === 2);
    await page.waitForFunction(() => window.__previewDecodeCount === 2);
    assert.equal(await page.locator('.browser-preview img').count(), 0, 'a restarted browser should wait for its new preview instead of showing a stale initial decode');
  } finally {
    await browser.close();
    await gui.close();
  }
});

test('monitor action endpoint rejects cross-origin and non-JSON writes', async () => {
  let actionCalls = 0;
  const monitorHub = {
    async action() { actionCalls += 1; return { ok: true }; },
    async close() {},
  };
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub });
  try {
    const path = `${gui.origin}/api/monitor/input-browser/action?pageId=input-page`;
    const plain = await request(path, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ action: 'keyboard', type: 'down', key: 'A' }),
    });
    assert.equal(plain.statusCode, 415);

    const foreign = await request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.test' },
      body: JSON.stringify({ action: 'keyboard', type: 'down', key: 'A' }),
    });
    assert.equal(foreign.statusCode, 403);

    const sameOrigin = await request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gui.origin },
      body: JSON.stringify({ action: 'keyboard', type: 'down', key: 'A' }),
    });
    assert.equal(sameOrigin.statusCode, 200);
    assert.equal(actionCalls, 1);
  } finally {
    await gui.close();
  }
});

test('gui proxies asset mutations while keeping other pw-dev mutations read-only', async () => {
  let received;
  const pwdev = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received = { method: req.method, url: req.url, body };
      writeJson(res, 200, { ok: true, browser: body ? JSON.parse(body) : undefined });
    });
  });
  await new Promise((resolve) => pwdev.listen(0, '127.0.0.1', resolve));
  const pwdevUrl = `http://127.0.0.1:${pwdev.address().port}`;
  const gui = await startPwDevGuiServer({ port: 0, pwDevUrl: pwdevUrl, brokerDiscovery: false });

  try {
    const configCreated = await postJson(`${gui.origin}/api/pwdev/browser-configs`, { id: 'gui-config', headless: true });
    assert.equal(configCreated.statusCode, 200);
    assert.deepEqual(received, {
      method: 'POST',
      url: '/_pwdev/browser-configs',
      body: '{"id":"gui-config","headless":true}',
    });

    const configDeleted = await request(`${gui.origin}/api/pwdev/browser-configs/gui-config`, { method: 'DELETE' });
    assert.equal(configDeleted.statusCode, 200);
    assert.equal(received.method, 'DELETE');
    assert.equal(received.url, '/_pwdev/browser-configs/gui-config');

    const created = await postJson(`${gui.origin}/api/pwdev/browsers`, { id: 'gui-browser', browserConfigId: 'gui-config' });
    assert.equal(created.statusCode, 200);
    assert.deepEqual(received, {
      method: 'POST',
      url: '/_pwdev/browsers',
      body: '{"id":"gui-browser","browserConfigId":"gui-config"}',
    });

    const deleted = await request(`${gui.origin}/api/pwdev/browsers/gui-browser`, { method: 'DELETE' });
    assert.equal(deleted.statusCode, 200);
    assert.equal(received.method, 'DELETE');
    assert.equal(received.url, '/_pwdev/browsers/gui-browser');

    const proxyCreated = await postJson(`${gui.origin}/api/pwdev/proxies`, { id: 'gui-proxy', proxyUrl: 'http://127.0.0.1:8899' });
    assert.equal(proxyCreated.statusCode, 200);
    assert.equal(received.url, '/_pwdev/proxies');
    const proxyDeleted = await request(`${gui.origin}/api/pwdev/proxies/gui-proxy`, { method: 'DELETE' });
    assert.equal(proxyDeleted.statusCode, 200);
    assert.equal(received.url, '/_pwdev/proxies/gui-proxy');

    const rejected = await postJson(`${gui.origin}/api/pwdev/apps`, { id: 'nope' });
    assert.equal(rejected.statusCode, 405);
  } finally {
    await gui.close();
    await new Promise((resolve) => pwdev.close(resolve));
  }
});

test('gui proxies a managed Whistle GUI under a same-origin route', async () => {
  const whistle = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.url === '/cgi-bin/server-info') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ec: 0,
          server: { ipv4: ['192.0.2.20'], ipv6: ['2001:db8::20'], port: 9800 },
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`whistle gui ${req.method} ${req.url} ${body}`);
    });
  });
  await new Promise((resolve) => whistle.listen(0, '127.0.0.1', resolve));
  const whistleUrl = `http://127.0.0.1:${whistle.address().port}`;
  const pwdev = await startJsonServer({
    '/_pwdev/proxies/proxy-main': {
      ok: true,
      proxy: { id: 'proxy-main', guiUrl: whistleUrl },
    },
  });
  const gui = await startPwDevGuiServer({ port: 0, pwDevUrl: pwdev.origin, brokerDiscovery: false });

  try {
    const response = await get(`${gui.origin}/proxy/proxy-main/gui/`);
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /whistle gui GET \/ /);

    const saved = await request(`${gui.origin}/proxy/proxy-main/gui/cgi-bin/rules/project`, {
      method: 'POST',
      body: 'name=local-api&rules=example.test',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(saved.statusCode, 200);
    assert.match(saved.body, /whistle gui POST \/cgi-bin\/rules\/project name=local-api&rules=example.test/);

    const serverInfo = await getJson(`${gui.origin}/proxy/proxy-main/gui/cgi-bin/server-info`);
    assert.equal(serverInfo.statusCode, 200);
    assert.deepEqual(serverInfo.body.server.ipv4, ['127.0.0.1']);
    assert.deepEqual(serverInfo.body.server.ipv6, []);
    assert.equal(serverInfo.body.server.port, `${new URL(gui.origin).port}/proxy/proxy-main/gui`);
  } finally {
    await gui.close();
    await pwdev.close();
    await new Promise((resolve) => whistle.close(resolve));
  }
});

test('gui snapshot collects from server, broker, and proxy manager', async () => {
  const pwdev = await startJsonServer({
    '/_pwdev/status': {
      ok: true,
      serverUrl: 'http://127.0.0.1:9696',
      broker: { configured: true, reachable: true },
      manifest: { ok: true, id: 'main' },
    },
    '/_pwdev/apps': {
      ok: true,
      apps: [{ id: 'main', networkId: 'agent-whistle' }],
    },
    '/_pwdev/browser-configs': {
      ok: true,
      browserConfigs: [{ id: 'main-browser', profile: 'work-okta' }],
    },
    '/_pwdev/browsers': {
      ok: true,
      browsers: [{ id: 'checkout-smoke', browserConfigId: 'main-browser', appId: 'main', proxyId: 'proxy-main' }],
    },
    '/_pwdev/proxies': { ok: true, proxies: [{ id: 'proxy-main' }] },
    '/_pwdev/networks': { ok: true, networks: [{ id: 'agent-whistle' }] },
  });
  const broker = await startJsonServer({
    '/_broker/status': {
      ok: true,
      state: 'active',
      instanceCount: 1,
      topology: { mode: 'local', remote: false },
      instances: [{ id: 'bkr_1', networkId: 'agent-whistle' }],
    },
    '/_broker/networks': { ok: true, networks: [{ id: 'agent-whistle', inUseBy: ['bkr_1'] }] },
    '/_broker/proxy-forwards': { ok: true, forwards: [] },
  });
  const proxy = await startJsonServer({
    '/_proxy/status': { ok: true, proxies: [{ id: 'proxy-main', running: true }] },
  });
  const gui = await startPwDevGuiServer({
    port: 0,
    pwDevUrl: pwdev.origin,
    brokerUrl: broker.origin,
    proxyManagerUrl: proxy.origin,
    brokerDiscovery: false,
  });

  try {
    const snapshot = await getJson(`${gui.origin}/api/snapshot`);
    assert.equal(snapshot.statusCode, 200);
    assert.equal(snapshot.body.ok, true);
    assert.equal(snapshot.body.server.apps.body.apps[0].id, 'main');
    assert.equal(snapshot.body.server.browserConfigs.body.browserConfigs[0].id, 'main-browser');
    assert.equal(snapshot.body.server.browsers.body.browsers[0].id, 'checkout-smoke');
    assert.deepEqual(snapshot.body.server.proxyStatuses, [{ id: 'proxy-main', running: true }]);
    assert.equal(snapshot.body.broker.status.body.state, 'active');
    assert.equal(snapshot.body.broker.status.body.instanceCount, 1);
    assert.equal(snapshot.body.proxyManager.status.body.proxies[0].id, 'proxy-main');
    assert.equal(pwdev.requests.includes('/_pwdev/networks'), false);
  } finally {
    await gui.close();
    await pwdev.close();
    await broker.close();
    await proxy.close();
  }
});

test('gui snapshot keeps SSH topology reported through pw-dev server', async () => {
  const pwdev = await startJsonServer({
    '/_pwdev/status': {
      ok: true,
      serverUrl: 'http://127.0.0.1:9696',
      broker: {
        configured: true,
        reachable: true,
        status: {
          ok: true,
          running: false,
          topology: {
            mode: 'ssh',
            remote: true,
            ssh: { target: 'user@code-server', remotePort: 18080 },
          },
          instances: [],
        },
      },
      manifest: { ok: true, id: 'main' },
    },
    '/_pwdev/apps': { ok: true, apps: [] },
    '/_pwdev/browser-configs': { ok: true, browserConfigs: [] },
    '/_pwdev/proxies': { ok: true, proxies: [] },
    '/_pwdev/networks': { ok: true, networks: [] },
  });
  const broker = await startJsonServer({
    '/_broker/status': { ok: true, state: 'idle', instanceCount: 0, instances: [] },
    '/_broker/networks': { ok: true, networks: [] },
    '/_broker/proxy-forwards': { ok: true, forwards: [] },
  });
  const proxy = await startJsonServer({
    '/_proxy/status': { ok: true, proxies: [] },
  });
  const gui = await startPwDevGuiServer({
    port: 0,
    pwDevUrl: pwdev.origin,
    brokerUrl: broker.origin,
    proxyManagerUrl: proxy.origin,
    brokerDiscovery: false,
  });

  try {
    const snapshot = await getJson(`${gui.origin}/api/snapshot`);
    assert.equal(snapshot.statusCode, 200);
    assert.equal(snapshot.body.server.status.body.broker.status.topology.mode, 'ssh');
  } finally {
    await gui.close();
    await pwdev.close();
    await broker.close();
    await proxy.close();
  }
});

test('gui snapshot discovers multiple brokers from server sessions', async () => {
  const broker1 = await startJsonServer({
    '/_broker/status': {
      ok: true,
      state: 'idle',
      instanceCount: 0,
      topology: { mode: 'ssh', remote: true },
      instances: [],
    },
    '/_broker/networks': { ok: true, networks: [] },
    '/_broker/proxy-forwards': { ok: true, forwards: [] },
  });
  const broker2 = await startJsonServer({
    '/_broker/status': {
      ok: true,
      state: 'active',
      instanceCount: 1,
      topology: { mode: 'local', remote: false },
      instances: [{ id: 'bkr_2' }],
    },
    '/_broker/networks': { ok: true, networks: [] },
    '/_broker/proxy-forwards': { ok: true, forwards: [] },
  });
  const pwdev = await startJsonServer({
    '/_pwdev/status': {
      ok: true,
      broker: { configured: true, reachable: true, url: broker1.origin },
      manifest: { ok: true, id: 'main' },
    },
    '/_pwdev/apps': { ok: true, apps: [] },
    '/_pwdev/browser-configs': { ok: true, browserConfigs: [] },
    '/_pwdev/sessions': {
      ok: true,
      sessions: [{ sessionId: 'session-2', brokerUrl: broker2.origin }],
    },
    '/_pwdev/proxies': { ok: true, proxies: [] },
    '/_pwdev/networks': { ok: true, networks: [] },
  });
  const proxy = await startJsonServer({ '/_proxy/status': { ok: true, proxies: [] } });
  const gui = await startPwDevGuiServer({
    port: 0,
    pwDevUrl: pwdev.origin,
    brokerUrl: broker1.origin,
    proxyManagerUrl: proxy.origin,
    brokerDiscovery: false,
  });

  try {
    const snapshot = await getJson(`${gui.origin}/api/snapshot`);
    assert.equal(snapshot.statusCode, 200);
    assert.equal(snapshot.body.brokers.length, 2);
    assert.equal(snapshot.body.brokers[0].status.body.state, 'idle');
    assert.equal(snapshot.body.brokers[1].status.body.state, 'active');
  } finally {
    await gui.close();
    await pwdev.close();
    await broker1.close();
    await broker2.close();
    await proxy.close();
  }
});

test('gui snapshot discovers ready brokers from the localhost scan range', async () => {
  const configuredBroker = await startJsonServer({
    '/_broker/status': { ok: true, state: 'idle', instanceCount: 0, instances: [] },
    '/_broker/networks': { ok: true, networks: [] },
    '/_broker/proxy-forwards': { ok: true, forwards: [] },
  });
  const scannedBroker = await startJsonServer({
    '/_broker/status': {
      ok: true,
      state: 'idle',
      instanceCount: 0,
      topology: { mode: 'ssh', remote: true, ssh: { target: 'user@host' } },
      instances: [],
    },
    '/_broker/networks': { ok: true, networks: [] },
    '/_broker/proxy-forwards': { ok: true, forwards: [] },
  });
  const pwdev = await startJsonServer({
    '/_pwdev/status': {
      ok: true,
      broker: { configured: true, reachable: true, url: configuredBroker.origin },
      manifest: { ok: true, id: 'main' },
    },
    '/_pwdev/apps': { ok: true, apps: [] },
    '/_pwdev/browser-configs': { ok: true, browserConfigs: [] },
    '/_pwdev/sessions': { ok: true, sessions: [] },
    '/_pwdev/browsers': { ok: true, browsers: [] },
    '/_pwdev/proxies': { ok: true, proxies: [] },
    '/_pwdev/networks': { ok: true, networks: [] },
  });
  const proxy = await startJsonServer({ '/_proxy/status': { ok: true, proxies: [] } });
  const scannedPort = new URL(scannedBroker.origin).port;
  const gui = await startPwDevGuiServer({
    port: 0,
    pwDevUrl: pwdev.origin,
    brokerUrl: configuredBroker.origin,
    proxyManagerUrl: proxy.origin,
    brokerDiscoveryPorts: [Number(scannedPort)],
  });

  try {
    const snapshot = await getJson(`${gui.origin}/api/snapshot`);
    assert.equal(snapshot.statusCode, 200);
    assert.equal(snapshot.body.brokers.length, 2);
    assert.equal(snapshot.body.brokers[0].discovered, false);
    assert.equal(snapshot.body.brokers[1].discovered, true);
    assert.equal(snapshot.body.brokers[1].url, scannedBroker.origin);
    assert.equal(snapshot.body.brokers[1].status.body.topology.remote, true);
  } finally {
    await gui.close();
    await pwdev.close();
    await configuredBroker.close();
    await scannedBroker.close();
    await proxy.close();
  }
});

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
  const close = async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      killTimer.unref();
      try {
        child.kill('SIGTERM');
        await exited;
      } finally {
        clearTimeout(killTimer);
      }
    }
    await fs.rm(userDataDir, { recursive: true, force: true });
  };
  let timer;
  try {
    const wsEndpoint = await new Promise((resolve, reject) => {
      let output = '';
      timer = setTimeout(() => reject(new Error(`Timed out starting Chromium: ${output}`)), 10_000);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        output += chunk;
        const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) resolve(match[1]);
      });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Chromium exited before CDP was ready: ${code}`)));
    });
    return { wsEndpoint, close };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function createMonitorBrowserDouble(initialPages) {
  const pages = [];
  const browserEvents = new EventEmitter();
  const contextEvents = new EventEmitter();
  let deferredPageDescription;
  let connected = true;
  let closeCalls = 0;
  const context = {
    on: contextEvents.on.bind(contextEvents),
    pages: () => pages.filter((page) => !page.isClosed()),
    newCDPSession: async (page) => ({
      send: async (method) => {
        assert.equal(method, 'Target.getTargetInfo');
        if (deferredPageDescription) {
          const deferred = deferredPageDescription;
          deferredPageDescription = undefined;
          deferred.markStarted();
          await deferred.promise;
        }
        return { targetInfo: { targetId: page.id } };
      },
      detach: async () => {},
    }),
  };
  const makePage = ({ id, title, url, lease, viewport: initialViewport }) => {
    const events = new EventEmitter();
    const frame = {};
    const inputActions = [];
    const navigationActions = [];
    let currentViewport = initialViewport ?? { width: 1280, height: 720 };
    let currentUrl = url;
    let closed = false;
    return {
      id,
      titleValue: title,
      lease,
      actions: [],
      inputActions,
      navigationActions,
      context: () => context,
      title: async () => title,
      url: () => currentUrl,
      navigateTo: (nextUrl) => { currentUrl = nextUrl; },
      isClosed: () => closed,
      closeTarget: () => { closed = true; events.emit('close'); },
      on: events.on.bind(events),
      emit: events.emit.bind(events),
      listenerCount: events.listenerCount.bind(events),
      mainFrame: () => frame,
      viewportSize: () => ({ ...currentViewport }),
      setViewportSize: async (viewport) => { currentViewport = { ...viewport }; },
      mouse: {
        move: async (x, y) => inputActions.push({ device: 'mouse', type: 'move', x, y }),
        down: async ({ button }) => inputActions.push({ device: 'mouse', type: 'down', button }),
        up: async ({ button }) => inputActions.push({ device: 'mouse', type: 'up', button }),
        wheel: async (deltaX, deltaY) => inputActions.push({ device: 'mouse', type: 'wheel', deltaX, deltaY }),
      },
      keyboard: {
        down: async (key) => inputActions.push({ device: 'keyboard', type: 'down', key }),
        up: async (key) => inputActions.push({ device: 'keyboard', type: 'up', key }),
        insertText: async (text) => inputActions.push({ device: 'keyboard', type: 'insertText', text }),
      },
      goBack: async (options) => { navigationActions.push({ type: 'back', options }); return null; },
      goForward: async (options) => { navigationActions.push({ type: 'forward', options }); return null; },
      reload: async (options) => { navigationActions.push({ type: 'reload', options }); },
      exposeFunction: async () => {},
      evaluate: async (_callback, value) => {
        if (value?.action) {
          const page = pages.find((candidate) => candidate.id === id);
          page.actions.push(value);
          return { tagName: 'BUTTON', text: title };
        }
        return {
          url: currentUrl,
          title,
          viewport: { ...currentViewport, devicePixelRatio: 1 },
          scroll: { x: 0, y: 0 },
          capturedAt: '2026-08-27T00:00:00.000Z',
        };
      },
      screenshot: async () => Buffer.from(id),
    };
  };
  const double = {
    browser: {
      contexts: () => [context],
      isConnected: () => connected,
      on: browserEvents.on.bind(browserEvents),
      close: async () => {
        if (!connected) return;
        closeCalls += 1;
        connected = false;
        browserEvents.emit('disconnected');
      },
    },
    open(rawPage) {
      const page = makePage(rawPage);
      pages.push(page);
      contextEvents.emit('page', page);
      return page;
    },
    closePage(id) {
      double.page(id).closeTarget();
    },
    page(id) {
      return pages.find((page) => page.id === id);
    },
    livePages: () => context.pages(),
    deferNextPageDescription() {
      let markStarted;
      let release;
      const started = new Promise((resolve) => { markStarted = resolve; });
      const promise = new Promise((resolve) => { release = resolve; });
      deferredPageDescription = { markStarted, promise };
      return { started, release };
    },
    get closeCalls() { return closeCalls; },
  };
  for (const page of initialPages) double.open(page);
  return double;
}

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

class MonitorResponseDouble extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writableEnded = false;
    this.chunks = [];
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  end() {
    this.writableEnded = true;
    this.emit('close');
  }

  events() {
    return this.chunks
      .flatMap((chunk) => chunk.split('\n\n'))
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => JSON.parse(chunk.slice(6)));
  }
}

function startJsonServer(routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const payload = routes[req.url];
    if (!payload) {
      writeJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    writeJson(res, 200, payload);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((error) => error ? closeReject(error) : closeResolve());
        }),
      });
    });
  });
}

function longContentSnapshot() {
  const snapshot = browserPreviewSnapshot();
  snapshot.server.browserConfigs.body.browserConfigs[0].targetUrl =
    'https://example.test/a/very/long/path/that/must/wrap?with=a-long-query-value&and=another-long-value';
  snapshot.server.browserConfigs.body.browserConfigs[0].proxyBypassList = [
    '*.internal.example.test', '*.services.example.test',
  ];
  snapshot.server.browsers.body.browsers[0].occupancy = {
    state: 'claimed', owner: 'another-agent', taskId: 'long-running-quality-check',
  };
  const appId = 'a'.repeat(64);
  const proxyId = 'p'.repeat(64);
  snapshot.server.browsers.body.browsers[0].appId = appId;
  snapshot.server.browsers.body.browsers[0].proxyId = proxyId;
  snapshot.server.apps.body.apps.push({ id: appId, appUrl: 'https://example.test/' });
  snapshot.server.proxies.body.proxies.push({ id: proxyId, proxyUrl: 'http://proxy.test:8899' });
  snapshot.server.remoteHosts.body.remoteHosts.push({ id: 'layout-host', name: 'h'.repeat(64), target: 'user@host.test', sshKeyId: 'layout-key' });
  snapshot.server.sshKeys.body.sshKeys.push({ id: 'layout-key', name: 'k'.repeat(64), fingerprint: 'SHA256:test-key' });
  return snapshot;
}

for (const view of ['browsers', 'remote-hosts', 'ssh-keys']) {
  test(`dashboard long content wraps in ${view} cards without document overflow`, async () => {
    const browser = await chromium.launch({ headless: true });
    const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub: { async close() {} } });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await routeDashboardSnapshot(page, longContentSnapshot());
      await page.goto(gui.origin);
      await page.locator('.browser-diagram').waitFor();
      await page.locator('#interval').selectOption('0');
      if (view !== 'browsers') {
        await page.locator('[data-nav-group="assets"] summary').click();
        await page.locator(`.nav-item[data-view="${view}"]`).click();
      }
      const text = page.locator(view === 'browsers' ? '.browser-node.app' : '.view.active .card-head h3');
      assert.equal((await text.textContent()).length, 64, 'the full unbroken reference or title remains available');
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${view} should wrap long text at ${width}px`);
        assert.equal(await text.evaluate((element) => element.scrollWidth <= element.clientWidth), true, 'long text should fit its own container');
      }
    } finally {
      await browser.close();
      await gui.close();
    }
  });
}

test('dashboard layout is compact and keeps actions reachable at desktop and mobile widths', async () => {
  const browser = await chromium.launch({ headless: true });
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub: { async close() {} } });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const pageErrors = [];
    const failedResponses = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('requestfailed', (request) => failedResponses.push(request.url()));
    page.on('response', (response) => {
      if (new URL(response.url()).origin === gui.origin && response.status() >= 400) {
        failedResponses.push(`${response.status()} ${response.url()}`);
      }
    });
    await routeDashboardSnapshot(page, longContentSnapshot());
    await page.goto(gui.origin);
    await page.locator('.browser-diagram').waitFor();
    await page.locator('#interval').selectOption('0');
    const contentWidth = await page.locator('.content').evaluate((element) => element.getBoundingClientRect().width);
    const cardWidth = await page.locator('.browser-diagram').evaluate((element) => element.getBoundingClientRect().width);
    assert.ok(cardWidth >= contentWidth * 0.9, 'a single browser should use the available content width');
    assert.equal(await page.locator('.browser-diagram-title').evaluate((heading) => heading.firstElementChild?.className), 'browser-diagram-info');
    await page.locator('[data-nav-group="assets"] summary').click();
    await page.locator('[data-nav-group="runtime"] summary').click();
    for (const view of ['browsers', 'browser-configs', 'proxies']) {
      await page.locator(`.nav-item[data-view="${view}"]`).click();
      const deletion = page.locator('.view.active').getByRole('button', { name: /Delete/ }).first();
      const box = await deletion.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 1440, `${view} desktop actions should be fully visible`);
      const style = await deletion.evaluate((button) => {
        const css = getComputedStyle(button);
        return { danger: button.classList.contains('button-danger'), color: css.color, background: css.backgroundColor, opacity: Number(css.opacity), cursor: css.cursor };
      });
      assert.equal(style.danger, true);
      assert.equal(style.color, 'rgb(179, 38, 30)');
      assert.equal(style.background, 'rgb(253, 232, 231)');
      if (view !== 'proxies') {
        assert.equal(await deletion.isDisabled(), true);
        assert.ok(style.opacity < 1);
        assert.equal(style.cursor, 'not-allowed');
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 1440);
    }
    await page.locator('.nav-item[data-view="browser-configs"]').click();
    await page.locator('#new-browser-config').click();
    await page.mouse.move(0, 0);
    assert.notEqual(await page.locator('#browser-config-reset-profile').evaluate((checkbox) => getComputedStyle(checkbox).accentColor), 'auto');
    for (const id of ['new-browser', 'save-browser', 'new-browser-config', 'save-browser-config', 'new-proxy', 'save-proxy']) {
      assert.equal(await page.locator(`#${id}`).evaluate((button) => getComputedStyle(button).backgroundColor), 'rgb(36, 91, 143)');
    }
    assert.deepEqual(await page.locator('.button-primary').allTextContents(), [
      'New browser', 'Save browser', 'New browser config', 'Save browser config', 'New proxy', 'Save proxy',
    ]);
    await page.locator('#cancel-browser-config').click();
    await page.locator('.nav-item[data-view="browsers"]').click();
    await page.getByRole('button', { name: 'Table', exact: true }).click();
    const browserDelete = page.locator('#browsers-table').getByRole('button', { name: 'Delete', exact: true });
    const desktopDeleteBox = await browserDelete.boundingBox();
    assert.ok(desktopDeleteBox.x + desktopDeleteBox.width <= 1440);
    assert.equal(await browserDelete.isDisabled(), true);
    assert.equal(await browserDelete.evaluate((button) => button.classList.contains('button-danger')), true);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const view of ['browsers', 'apps', 'browser-configs', 'proxies', 'sessions', 'broker', 'remote-hosts', 'ssh-keys']) {
      if (view !== 'browsers') {
        const group = page.locator(`[data-nav-group="${['sessions', 'broker'].includes(view) ? 'runtime' : 'assets'}"]`);
        if (await group.getAttribute('open') === null) await group.locator('summary').click();
      }
      await page.locator(`.nav-item[data-view="${view}"]`).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, `${view} should not overflow the document`);
      if (view === 'browsers' || view === 'browser-configs' || view === 'proxies') {
        const scroll = page.locator('.view.active .table-scroll');
        await scroll.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
        const action = page.locator('.view.active').getByRole('button', { name: /Delete/ });
        const box = await action.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= 390, `${view} mobile actions should be reachable by scrolling the table`);
      }
      if (view === 'browsers') {
        await page.getByRole('button', { name: 'Diagram', exact: true }).click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
        const title = await page.locator('.browser-diagram-info').boundingBox();
        const controls = await page.locator('.browser-diagram-controls').boundingBox();
        assert.ok(controls.y >= title.y + title.height, 'mobile controls should wrap below the title');
      }
    }
    const metrics = await page.locator('.metric').all();
    const rows = new Set(await Promise.all(metrics.map(async (metric) => Math.round((await metric.boundingBox()).y))));
    assert.equal(rows.size, 2, 'four metrics should form two compact rows');
    for (const metric of metrics) assert.ok((await metric.boundingBox()).height <= 90);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(failedResponses, []);
  } finally {
    await browser.close();
    await gui.close();
  }
});

test('dashboard uses contextual empty copy and readable broker labels', async () => {
  const browser = await chromium.launch({ headless: true });
  const gui = await startPwDevGuiServer({ port: 0, brokerDiscovery: false, monitorHub: { async close() {} } });
  try {
    const page = await browser.newPage();
    const snapshot = browserPreviewSnapshot();
    for (const key of ['apps', 'browserConfigs', 'sessions', 'browsers', 'proxies', 'sshKeys', 'remoteHosts']) snapshot.server[key].body[key] = [];
    await routeDashboardSnapshot(page, snapshot);
    await page.goto(gui.origin);
    await page.getByText('No browsers', { exact: true }).waitFor();
    await page.locator('#interval').selectOption('0');
    await page.locator('[data-nav-group="assets"] summary').click();
    await page.locator('[data-nav-group="runtime"] summary').click();
    for (const [view, copy] of [['apps', 'No apps'], ['browser-configs', 'No browser configs'], ['proxies', 'No proxies'], ['sessions', 'No sessions'], ['remote-hosts', 'No remote hosts'], ['ssh-keys', 'No SSH keys']]) {
      await page.locator(`.nav-item[data-view="${view}"]`).click();
      assert.equal(await page.locator('.view.active .empty').textContent(), copy);
    }
    await page.locator('.nav-item[data-view="browsers"]').click();
    await page.getByRole('button', { name: 'Table', exact: true }).click();
    assert.equal(await page.locator('.view.active .empty:visible').textContent(), 'No browsers');
    await page.locator('.nav-item[data-view="broker"]').click();
    assert.equal(await page.locator('.broker-card h3').textContent(), 'Broker 1');
    assert.equal(await page.getByRole('button', { name: 'Refresh now', exact: true }).count(), 1);
    assert.equal(await page.locator('label.inline-field > span').textContent(), 'Auto refresh');
  } finally {
    await browser.close();
    await gui.close();
  }
});

function browserPreviewSnapshot() {
  const ok = (body) => ({ ok: true, body });
  return {
    collectedAt: '2026-09-04T00:00:00.000Z',
    urls: { brokerUrl: 'http://broker.test' },
    server: {
      status: ok({ ok: true, manifest: { id: 'pwdev' }, broker: { reachable: true } }),
      apps: ok({ apps: [] }),
      browserConfigs: ok({ browserConfigs: [{ id: 'preview-config', headless: true }] }),
      sessions: ok({ sessions: [{ sessionId: 'preview-session', browserId: 'preview-browser', browserConfigId: 'preview-config', scope: 'default' }] }),
      browsers: ok({ browsers: [{ id: 'preview-browser', name: 'Preview browser', browserConfigId: 'preview-config', sessionId: 'preview-session', status: 'occupied', occupancy: { state: 'unclaimed' } }] }),
      proxies: ok({ proxies: [] }),
      sshKeys: ok({ sshKeys: [] }),
      remoteHosts: ok({ remoteHosts: [] }),
      proxyStatuses: [],
    },
    broker: {
      status: ok({ ok: true, state: 'active', instances: [] }),
      networks: ok({ networks: [] }),
      proxyForwards: ok({ forwards: [] }),
    },
    proxyManager: { status: ok({ ok: true, proxies: [] }) },
    brokers: [],
  };
}

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

function get(url) {
  return request(url, { method: 'GET' });
}

async function getJson(url) {
  const response = await get(url);
  return { ...response, body: JSON.parse(response.body) };
}

async function postJson(url, body) {
  const response = await request(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return { ...response, body: JSON.parse(response.body) };
}

function request(rawUrl, { method, body, headers } = {}) {
  const url = new URL(rawUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        responseBody += chunk;
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: responseBody });
      });
    });
    req.once('error', reject);
    req.end(body);
  });
}

function writeJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
  });
  res.end(body);
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
