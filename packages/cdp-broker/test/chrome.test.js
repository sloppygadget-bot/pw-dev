import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { buildChromeArgs, findChromeExecutable, waitForChrome } from '../src/chrome.js';

test('adds proxy and SSL launch options before extra Chrome args', () => {
  assert.deepEqual(
    buildChromeArgs({
      remoteDebuggingPort: 9222,
      userDataDir: '/tmp/profile',
      proxyServer: 'http://127.0.0.1:8899',
      proxyBypassList: '<-loopback>',
      ignoreSslErrors: true,
      extraArgs: ['--window-size=1280,720'],
    }),
    [
      '--remote-debugging-port=9222',
      '--user-data-dir=/tmp/profile',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      '--proxy-server=http://127.0.0.1:8899',
      '--proxy-bypass-list=<-loopback>',
      '--ignore-certificate-errors',
      '--window-size=1280,720',
      'about:blank',
    ]
  );
});

test('finds installed Microsoft Edge on Windows when Chrome is absent', () => {
  const edge = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
  assert.equal(
    findChromeExecutable(undefined, {
      platform: 'win32',
      env: { PROGRAMFILES: 'C:\\Program Files' },
      existsSync: (candidate) => candidate === edge,
    }),
    edge
  );
});

test('waitForChrome honors its overall deadline when Chrome never responds', async () => {
  const chrome = http.createServer(() => {});
  await new Promise((resolve) => chrome.listen(0, '127.0.0.1', resolve));
  const address = chrome.address();
  const startedAt = Date.now();
  try {
    await assert.rejects(
      waitForChrome({ host: '127.0.0.1', port: address.port, timeoutMs: 100, intervalMs: 5 }),
      /within 100ms/
    );
    assert.ok(Date.now() - startedAt < 1_000);
  } finally {
    chrome.closeAllConnections?.();
    await new Promise((resolve) => chrome.close(resolve));
  }
});
