import assert from 'node:assert/strict';
import test from 'node:test';

import { buildChromeArgs } from '../src/chrome.js';

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
