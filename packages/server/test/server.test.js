import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveStaticPath, startPwDevServer } from '../src/index.js';
import { parseArgs } from '../src/cli.js';

test('parseArgs reads server options', () => {
  const options = parseArgs([
    '--host', '0.0.0.0',
    '--port', '4111',
    '--root', 'examples/static-site',
    '--id', 'checkout-main',
    '--name', 'Checkout main',
    '--worktree', '.',
    '--branch', 'main',
    '--app-url', 'http://127.0.0.1:5173',
    '--broker-url', 'http://127.0.0.1:18080',
    '--proxy-manager-url', 'http://127.0.0.1:18081',
    '--cdp-url', 'http://127.0.0.1:18080/_broker/instances/checkout-main',
    '--profile', 'checkout-main',
    '--proxy-forward-id', 'whistle',
    '--proxy-server', 'http://127.0.0.1:8899',
  ]);
  assert.equal(options.host, '0.0.0.0');
  assert.equal(options.port, 4111);
  assert.equal(options.root.endsWith(path.join('examples', 'static-site')), true);
  assert.equal(options.id, 'checkout-main');
  assert.equal(options.name, 'Checkout main');
  assert.equal(options.worktree, process.cwd());
  assert.equal(options.branch, 'main');
  assert.equal(options.appUrl, 'http://127.0.0.1:5173');
  assert.equal(options.brokerUrl, 'http://127.0.0.1:18080');
  assert.equal(options.proxyManagerUrl, 'http://127.0.0.1:18081');
  assert.equal(options.cdpUrl, 'http://127.0.0.1:18080/_broker/instances/checkout-main');
  assert.equal(options.profile, 'checkout-main');
  assert.equal(options.proxyForwardId, 'whistle');
  assert.equal(options.proxyServer, 'http://127.0.0.1:8899');
});

test('resolveStaticPath keeps requests under root', () => {
  assert.equal(resolveStaticPath('/tmp/site', '/index.html'), '/tmp/site/index.html');
  assert.equal(resolveStaticPath('/tmp/site', '/../secret'), '/tmp/site/secret');
});

test('server serves static index and health', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-server-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>ok</h1>');
  const server = await startPwDevServer({ root, port: 0 });
  try {
    const health = await get(`${server.origin}/healthz`);
    assert.equal(health.statusCode, 200);
    assert.match(health.body, /"ok":true/);

    const index = await get(`${server.origin}/`);
    assert.equal(index.statusCode, 200);
    assert.equal(index.body, '<h1>ok</h1>');
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server exposes pw-dev manifest and status endpoints', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-server-'));
  const server = await startPwDevServer({
    root,
    port: 0,
    id: 'checkout-main',
    name: 'Checkout main',
    worktree: root,
    branch: 'main',
    appUrl: 'http://127.0.0.1:5173',
    brokerUrl: 'http://127.0.0.1:18080',
    cdpUrl: 'http://127.0.0.1:18080/_broker/instances/checkout-main',
    profile: 'checkout-main',
  });
  try {
    const manifestResponse = await get(`${server.origin}/_pwdev/manifest`);
    assert.equal(manifestResponse.statusCode, 200);
    const manifest = JSON.parse(manifestResponse.body);
    assert.deepEqual(manifest, {
      ok: true,
      id: 'checkout-main',
      name: 'Checkout main',
      root,
      worktree: root,
      branch: 'main',
      appUrl: 'http://127.0.0.1:5173',
      cdpUrl: 'http://127.0.0.1:18080/_broker/instances/checkout-main',
      profile: 'checkout-main',
      serverUrl: server.origin,
    });

    const statusResponse = await get(`${server.origin}/_pwdev/status`);
    assert.equal(statusResponse.statusCode, 200);
    const status = JSON.parse(statusResponse.body);
    assert.equal(status.ok, true);
    assert.equal(status.serverUrl, server.origin);
    assert.equal(status.broker.configured, true);
    assert.equal(status.broker.reachable, false);
    assert.equal(status.manifest.id, 'checkout-main');
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server defaults manifest appUrl to its own origin', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-server-'));
  const server = await startPwDevServer({ root, port: 0 });
  try {
    const response = await get(`${server.origin}/_pwdev/manifest`);
    assert.equal(response.statusCode, 200);
    const manifest = JSON.parse(response.body);
    assert.equal(manifest.id, path.basename(root));
    assert.equal(manifest.name, path.basename(root));
    assert.equal(manifest.appUrl, server.origin);
    assert.equal(manifest.serverUrl, server.origin);
    assert.equal(manifest.brokerUrl, undefined);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server exposes instructions and client helper source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-server-'));
  const server = await startPwDevServer({ root, port: 0 });
  try {
    const instructions = await get(`${server.origin}/_pwdev/instructions`);
    assert.equal(instructions.statusCode, 200);
    assert.match(instructions.body, /\/_pwdev\/status/);
    assert.match(instructions.body, /\/_pwdev\/apps\/checkout-tax\/manifest/);
    assert.match(instructions.body, /\/_pwdev\/broker\/\*/);
    assert.match(instructions.body, /Branch\/app lifecycle guidelines/);
    assert.match(instructions.body, /stop the previous broker instance/);
    assert.match(instructions.body, /\/_pwdev\/broker\/proxy-forwards/);
    assert.match(instructions.body, /brokerProxyForwardId/);

    const client = await get(`${server.origin}/_pwdev/client.js`);
    assert.equal(client.statusCode, 200);
    assert.match(client.body, /loadPwDevStatus/);
    assert.match(client.body, /registerPwDevProxy/);
    assert.match(client.body, /registerPwDevApp/);
    assert.match(client.body, /loadPwDevManifest/);
    assert.match(client.body, /connectPwDev/);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server registers and exposes multiple apps', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-server-'));
  const server = await startPwDevServer({
    root,
    port: 0,
    id: 'checkout-main',
    appUrl: 'http://127.0.0.1:5173',
  });
  try {
    const created = await postJson(`${server.origin}/_pwdev/apps`, {
      id: 'checkout-tax',
      name: 'Checkout tax',
      worktree: root,
      branch: 'feature/tax',
      appUrl: 'http://127.0.0.1:5174',
      devserver: {
        command: 'npm',
        args: ['run', 'dev'],
        cwd: root,
        env: {
          PORT: '5174',
        },
      },
      engine: {
        name: 'node',
        version: process.version,
        requirement: '>=18',
      },
      accounts: {
        login: {
          usr: 'xxx',
          pwd: 'xxx',
        },
      },
      cdpUrl: 'http://127.0.0.1:18080/_broker/instances/checkout-tax',
      profile: 'checkout-tax',
      proxyForwardId: 'whistle',
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.body.app.id, 'checkout-tax');
    assert.equal(created.body.app.proxyForwardId, 'whistle');
    assert.deepEqual(created.body.app.devserver, {
      command: 'npm',
      args: ['run', 'dev'],
      cwd: root,
      env: {
        PORT: '5174',
      },
    });
    assert.deepEqual(created.body.app.engine, {
      name: 'node',
      version: process.version,
      requirement: '>=18',
    });
    assert.deepEqual(created.body.app.accounts, {
      login: {
        usr: 'xxx',
        pwd: 'xxx',
      },
    });

    const updated = await postJson(`${server.origin}/_pwdev/apps`, {
      id: 'checkout-tax',
      appUrl: 'http://127.0.0.1:5175',
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.body.app.name, 'Checkout tax');
    assert.equal(updated.body.app.appUrl, 'http://127.0.0.1:5175');

    const list = await getJson(`${server.origin}/_pwdev/apps`);
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.body.apps.map((app) => app.id), ['checkout-main', 'checkout-tax']);

    const manifest = await getJson(`${server.origin}/_pwdev/apps/checkout-tax/manifest`);
    assert.equal(manifest.statusCode, 200);
    assert.equal(manifest.body.id, 'checkout-tax');
    assert.equal(manifest.body.appUrl, 'http://127.0.0.1:5175');
    assert.equal(manifest.body.devserver.command, 'npm');

    const deleted = await deleteJson(`${server.origin}/_pwdev/apps/checkout-tax`);
    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.body.id, 'checkout-tax');

    const missing = await getJson(`${server.origin}/_pwdev/apps/checkout-tax`);
    assert.equal(missing.statusCode, 404);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server validates app devserver metadata', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-server-'));
  const server = await startPwDevServer({
    root,
    port: 0,
    id: 'checkout-main',
  });
  try {
    const created = await postJson(`${server.origin}/_pwdev/apps`, {
      id: 'checkout-tax',
      appUrl: 'http://127.0.0.1:5174',
      devserver: {
        command: 'npm',
        args: ['run', 123],
      },
    });
    assert.equal(created.statusCode, 400);
    assert.match(created.body.error, /devserver\.args\[1\] must be a non-empty string/);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server manages reusable proxy registrations', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-server-'));
  const server = await startPwDevServer({
    root,
    port: 0,
    id: 'checkout-main',
  });
  try {
    const created = await postJson(`${server.origin}/_pwdev/proxies`, {
      id: 'whistle-main',
      kind: 'whistle',
      name: 'Shared Whistle',
      appId: 'checkout-main',
      taskId: 'smoke-login-20260703',
      owner: 'codex',
      purpose: 'Smoke login verification',
      labels: ['smoke', 'login'],
      proxyUrl: 'http://127.0.0.1:8899',
      guiUrl: 'http://127.0.0.1:9801',
      rulesetFile: '/tmp/ruleset.txt',
      managed: true,
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.body.proxy.id, 'whistle-main');
    assert.equal(created.body.proxy.proxyUrl, 'http://127.0.0.1:8899');
    assert.equal(created.body.proxy.guiUrl, 'http://127.0.0.1:9801');
    assert.equal(created.body.proxy.appId, 'checkout-main');
    assert.equal(created.body.proxy.taskId, 'smoke-login-20260703');
    assert.equal(created.body.proxy.owner, 'codex');
    assert.equal(created.body.proxy.purpose, 'Smoke login verification');
    assert.deepEqual(created.body.proxy.labels, ['smoke', 'login']);
    assert.equal(created.body.proxy.rulesetFile, '/tmp/ruleset.txt');
    assert.equal(created.body.proxy.managed, true);

    const updated = await postJson(`${server.origin}/_pwdev/proxies`, {
      id: 'whistle-main',
      proxyUrl: 'http://127.0.0.1:8898',
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.body.proxy.kind, 'whistle');
    assert.equal(updated.body.proxy.proxyUrl, 'http://127.0.0.1:8898');

    const list = await getJson(`${server.origin}/_pwdev/proxies`);
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.body.proxies.map((proxy) => proxy.id), ['whistle-main']);

    const proxy = await getJson(`${server.origin}/_pwdev/proxies/whistle-main`);
    assert.equal(proxy.statusCode, 200);
    assert.equal(proxy.body.proxy.proxyUrl, 'http://127.0.0.1:8898');

    const deleted = await deleteJson(`${server.origin}/_pwdev/proxies/whistle-main`);
    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.body.id, 'whistle-main');

    const missing = await getJson(`${server.origin}/_pwdev/proxies/whistle-main`);
    assert.equal(missing.statusCode, 404);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server patches app registrations', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-server-'));
  const server = await startPwDevServer({
    root,
    port: 0,
    id: 'checkout-main',
  });
  try {
    const patched = await patchJson(`${server.origin}/_pwdev/apps/checkout-main`, {
      proxyId: 'whistle-main',
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.body.app.proxyId, 'whistle-main');

    const app = await getJson(`${server.origin}/_pwdev/apps/checkout-main`);
    assert.equal(app.body.app.proxyId, 'whistle-main');

    const rejected = await patchJson(`${server.origin}/_pwdev/apps/checkout-main`, {
      appUrl: 'http://127.0.0.1:9999',
    });
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.body.error, /Unsupported app patch field: appUrl/);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server validates proxy and account registrations', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-server-'));
  const server = await startPwDevServer({
    root,
    port: 0,
    id: 'checkout-main',
  });
  try {
    const badProxy = await postJson(`${server.origin}/_pwdev/proxies`, {
      id: 'whistle-main',
      proxyUrl: 'http://127.0.0.1:8899',
      brokerProxyForwardId: 'whistle',
    });
    assert.equal(badProxy.statusCode, 400);
    assert.match(badProxy.body.error, /proxyUrl and brokerProxyForwardId are mutually exclusive/);

    const badAccounts = await postJson(`${server.origin}/_pwdev/apps`, {
      id: 'checkout-tax',
      accounts: {
        login: {
          usr: 'xxx',
        },
      },
    });
    assert.equal(badAccounts.statusCode, 400);
    assert.match(badAccounts.body.error, /accounts\.login\.pwd must be a non-empty string/);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server manages app browser sessions through broker', async () => {
  const broker = await startMockBroker();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-server-'));
  const server = await startPwDevServer({
    root,
    port: 0,
    id: 'checkout-main',
    brokerUrl: broker.origin,
  });
  try {
    await postJson(`${server.origin}/_pwdev/apps`, {
      id: 'checkout-tax',
      appUrl: 'http://127.0.0.1:5174',
      profile: 'checkout-tax',
      proxyForwardId: 'whistle',
    });

    const started = await postJson(`${server.origin}/_pwdev/apps/checkout-tax/browser/start`, {
      ignoreSslErrors: true,
      task: {
        id: 'smoke-login-20260629',
        label: 'Smoke login flow',
        owner: 'codex',
      },
    });
    assert.equal(started.statusCode, 200);
    assert.equal(started.body.session.sessionId, 'checkout-tax__smoke-login-20260629');
    assert.equal(started.body.session.browserInstanceId, 'bkr_checkout-tax__smoke-login-20260629');
    assert.equal(started.body.session.profile, 'checkout-tax__smoke-login-20260629');
    assert.equal(started.body.session.cdpUrl, `${server.origin}/_pwdev/broker/instances/bkr_checkout-tax__smoke-login-20260629`);
    assert.equal(started.body.browser.cdpUrl, `${server.origin}/_pwdev/broker/instances/bkr_checkout-tax__smoke-login-20260629`);
    assert.equal(started.body.session.proxyForwardId, 'whistle');
    assert.deepEqual(
      omitStartedAt(started.body.session.activeTask),
      {
        id: 'smoke-login-20260629',
        label: 'Smoke login flow',
        owner: 'codex',
      }
    );
    assert.match(started.body.session.activeTask.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(
      started.body.app.browserSessions['checkout-tax__smoke-login-20260629'].cdpUrl,
      `${server.origin}/_pwdev/broker/instances/bkr_checkout-tax__smoke-login-20260629`
    );
    assert.equal(started.body.app.cdpUrl, undefined);
    assert.deepEqual(broker.requests[0], {
      method: 'POST',
      path: '/_broker/start',
      body: {
        profile: 'checkout-tax__smoke-login-20260629',
        proxyForwardId: 'whistle',
        ignoreSslErrors: true,
      },
    });

    const manifest = await getJson(`${server.origin}/_pwdev/apps/checkout-tax/manifest`);
    assert.equal(manifest.statusCode, 200);
    assert.equal(manifest.body.browserSessions['checkout-tax__smoke-login-20260629'].activeTask.id, 'smoke-login-20260629');

    const status = await getJson(`${server.origin}/_pwdev/apps/checkout-tax/browser/status`);
    assert.equal(status.statusCode, 200);
    assert.equal(status.body.broker.running, true);
    assert.equal(status.body.app.browserSessions['checkout-tax__smoke-login-20260629'].activeTask.owner, 'codex');

    const stopped = await postJson(`${server.origin}/_pwdev/apps/checkout-tax/browser/stop`, {
      taskId: 'smoke-login-20260629',
    });
    assert.equal(stopped.statusCode, 200);
    assert.equal(stopped.body.browser.stopped, 'bkr_checkout-tax__smoke-login-20260629');
    assert.equal(stopped.body.app.cdpUrl, undefined);
    assert.equal(stopped.body.app.browserInstanceId, undefined);
    assert.equal(stopped.body.app.activeTask, undefined);
    assert.equal(stopped.body.app.browserSessions, undefined);
  } finally {
    await server.close();
    await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server resolves app proxyId to proxy server for browser start', async () => {
  const broker = await startMockBroker();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-server-'));
  const server = await startPwDevServer({
    root,
    port: 0,
    id: 'checkout-main',
    brokerUrl: broker.origin,
  });
  try {
    await postJson(`${server.origin}/_pwdev/proxies`, {
      id: 'whistle-main',
      kind: 'whistle',
      proxyUrl: 'http://127.0.0.1:8899',
    });
    await postJson(`${server.origin}/_pwdev/apps`, {
      id: 'checkout-tax',
      appUrl: 'http://127.0.0.1:5174',
      profile: 'checkout-tax',
      proxyId: 'whistle-main',
    });

    const started = await postJson(`${server.origin}/_pwdev/apps/checkout-tax/browser/start`, {});
    assert.equal(started.statusCode, 200);
    assert.equal(started.body.app.proxyId, 'whistle-main');
    assert.equal(started.body.app.proxyServer, 'http://127.0.0.1:8899');
    assert.deepEqual(broker.requests[0], {
      method: 'POST',
      path: '/_broker/start',
      body: {
        profile: 'checkout-tax',
        proxyServer: 'http://127.0.0.1:8899',
      },
    });
  } finally {
    await server.close();
    await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server resolves broker proxy-forward registrations for browser start', async () => {
  const broker = await startMockBroker();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-server-'));
  const server = await startPwDevServer({
    root,
    port: 0,
    id: 'checkout-main',
    brokerUrl: broker.origin,
  });
  try {
    await postJson(`${server.origin}/_pwdev/proxies`, {
      id: 'whistle-forward',
      kind: 'whistle',
      brokerProxyForwardId: 'whistle',
    });
    await postJson(`${server.origin}/_pwdev/apps`, {
      id: 'checkout-tax',
      appUrl: 'http://127.0.0.1:5174',
      profile: 'checkout-tax',
      proxyId: 'whistle-forward',
    });

    const started = await postJson(`${server.origin}/_pwdev/apps/checkout-tax/browser/start`, {});
    assert.equal(started.statusCode, 200);
    assert.equal(started.body.app.proxyId, 'whistle-forward');
    assert.equal(started.body.app.proxyForwardId, 'whistle');
    assert.deepEqual(broker.requests[0], {
      method: 'POST',
      path: '/_broker/start',
      body: {
        profile: 'checkout-tax',
        proxyForwardId: 'whistle',
      },
    });
  } finally {
    await server.close();
    await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server rejects unknown app proxyId on browser start', async () => {
  const broker = await startMockBroker();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-server-'));
  const server = await startPwDevServer({
    root,
    port: 0,
    id: 'checkout-main',
    brokerUrl: broker.origin,
  });
  try {
    await postJson(`${server.origin}/_pwdev/apps`, {
      id: 'checkout-tax',
      appUrl: 'http://127.0.0.1:5174',
      profile: 'checkout-tax',
      proxyId: 'missing-proxy',
    });

    const started = await postJson(`${server.origin}/_pwdev/apps/checkout-tax/browser/start`, {});
    assert.equal(started.statusCode, 404);
    assert.match(started.body.error, /Unknown proxy: missing-proxy/);
    assert.equal(broker.requests.length, 0);
  } finally {
    await server.close();
    await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server probes default broker URL when broker-url is omitted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-server-'));
  const server = await startPwDevServer({ root, port: 0, id: 'checkout-main' });
  try {
    await postJson(`${server.origin}/_pwdev/apps`, {
      id: 'checkout-tax',
      appUrl: 'http://127.0.0.1:5174',
      profile: 'checkout-tax',
    });

    const status = await getJson(`${server.origin}/_pwdev/status`);
    assert.equal(status.statusCode, 200);
    assert.equal(status.body.broker.configured, true);
    assert.equal(status.body.broker.default, true);
    assert.equal(status.body.broker.url, 'http://127.0.0.1:18080');
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server broker probing does not require global fetch', async () => {
  const broker = await startMockBroker();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-server-'));
  const server = await startPwDevServer({
    root,
    port: 0,
    id: 'checkout-main',
    brokerUrl: broker.origin,
  });
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = undefined;
    const status = await getJson(`${server.origin}/_pwdev/status`);
    assert.equal(status.statusCode, 200);
    assert.equal(status.body.broker.configured, true);
    assert.equal(status.body.broker.reachable, true);
    assert.equal(status.body.broker.status.running, true);
    assert.deepEqual(broker.requests[0], {
      method: 'GET',
      path: '/_broker/status',
      body: {},
    });
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
    await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server validates browser task metadata', async () => {
  const broker = await startMockBroker();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-server-'));
  const server = await startPwDevServer({
    root,
    port: 0,
    id: 'checkout-main',
    brokerUrl: broker.origin,
  });
  try {
    await postJson(`${server.origin}/_pwdev/apps`, {
      id: 'checkout-tax',
      appUrl: 'http://127.0.0.1:5174',
      profile: 'checkout-tax',
    });

    const started = await postJson(`${server.origin}/_pwdev/apps/checkout-tax/browser/start`, {
      task: {
        label: 'Missing task id',
      },
    });
    assert.equal(started.statusCode, 400);
    assert.match(started.body.error, /task\.id must be a non-empty string/);
  } finally {
    await server.close();
    await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server rejects duplicate browser start while task is active', async () => {
  const broker = await startMockBroker();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-server-'));
  const server = await startPwDevServer({
    root,
    port: 0,
    id: 'checkout-main',
    brokerUrl: broker.origin,
  });
  try {
    await postJson(`${server.origin}/_pwdev/apps`, {
      id: 'checkout-tax',
      appUrl: 'http://127.0.0.1:5174',
      profile: 'checkout-tax',
    });

    const first = await postJson(`${server.origin}/_pwdev/apps/checkout-tax/browser/start`, {
      task: {
        id: 'smoke-login-20260629',
        label: 'Smoke login flow',
        owner: 'codex',
      },
    });
    assert.equal(first.statusCode, 200);

    const duplicate = await postJson(`${server.origin}/_pwdev/apps/checkout-tax/browser/start`, {
      task: {
        id: 'smoke-login-20260629',
        label: 'Smoke login flow',
        owner: 'codex',
      },
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.body.error, 'App already has an active browser session for task');
    assert.equal(duplicate.body.appId, 'checkout-tax');
    assert.equal(duplicate.body.sessionId, 'checkout-tax__smoke-login-20260629');
    assert.equal(duplicate.body.taskId, 'smoke-login-20260629');
    assert.equal(duplicate.body.profile, 'checkout-tax__smoke-login-20260629');
    assert.equal(duplicate.body.browserInstanceId, 'bkr_checkout-tax__smoke-login-20260629');
    assert.equal(duplicate.body.activeTask.id, 'smoke-login-20260629');
    assert.equal(broker.requests.filter((request) => request.path === '/_broker/start').length, 1);
  } finally {
    await server.close();
    await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server starts parallel task browser sessions for one app', async () => {
  const broker = await startMockBroker();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-server-'));
  const server = await startPwDevServer({
    root,
    port: 0,
    id: 'checkout-main',
    brokerUrl: broker.origin,
  });
  try {
    await postJson(`${server.origin}/_pwdev/apps`, {
      id: 'main',
      appUrl: 'http://127.0.0.1:5173',
      profile: 'main',
    });

    const first = await postJson(`${server.origin}/_pwdev/apps/main/browser/start`, {
      task: {
        id: 'task-a',
        owner: 'codex',
      },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.session.sessionId, 'main__task-a');
    assert.equal(first.body.session.profile, 'main__task-a');
    assert.equal(first.body.session.browserInstanceId, 'bkr_main__task-a');

    const second = await postJson(`${server.origin}/_pwdev/apps/main/browser/start`, {
      task: {
        id: 'task-b',
        owner: 'codex',
      },
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.body.session.sessionId, 'main__task-b');
    assert.equal(second.body.session.profile, 'main__task-b');
    assert.equal(second.body.session.browserInstanceId, 'bkr_main__task-b');
    assert.equal(second.body.app.browserSessions['main__task-a'].profile, 'main__task-a');
    assert.equal(second.body.app.browserSessions['main__task-b'].profile, 'main__task-b');
    assert.equal(second.body.app.browserInstanceId, undefined);
    assert.deepEqual(
      broker.requests
        .filter((request) => request.path === '/_broker/start')
        .map((request) => request.body.profile),
      ['main__task-a', 'main__task-b']
    );
  } finally {
    await server.close();
    await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server proxies broker HTTP APIs', async () => {
  const broker = await startMockBroker();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-server-'));
  const server = await startPwDevServer({
    root,
    port: 0,
    id: 'checkout-main',
    brokerUrl: broker.origin,
  });
  try {
    const status = await getJson(`${server.origin}/_pwdev/broker/status`);
    assert.equal(status.statusCode, 200);
    assert.equal(status.body.running, true);
    assert.deepEqual(broker.requests[0], {
      method: 'GET',
      path: '/_broker/status',
      body: {},
    });
  } finally {
    await server.close();
    await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server proxies proxy HTTP APIs', async () => {
  const manager = await startMockProxyManager();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-server-'));
  const server = await startPwDevServer({
    root,
    port: 0,
    id: 'checkout-main',
    proxyManagerUrl: manager.origin,
  });
  try {
    const status = await getJson(`${server.origin}/_pwdev/proxy/status`);
    assert.equal(status.statusCode, 200);
    assert.equal(status.body.manager, true);
    assert.deepEqual(manager.requests[0], {
      method: 'GET',
      path: '/_proxy/status',
      body: {},
    });
  } finally {
    await server.close();
    await manager.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server proxies broker websocket upgrades', async () => {
  const broker = await startMockBroker();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-server-'));
  const server = await startPwDevServer({
    root,
    port: 0,
    id: 'checkout-main',
    brokerUrl: broker.origin,
  });
  try {
    const response = await upgrade(`${server.origin}/_pwdev/broker/instances/bkr_checkout/ws`);
    assert.match(response, /101 Switching Protocols/);
    assert.match(response, /broker-upgrade-ok/);
    assert.deepEqual(broker.upgrades[0], {
      method: 'GET',
      path: '/_broker/instances/bkr_checkout/ws',
    });
  } finally {
    await server.close();
    await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({ statusCode: response.statusCode, body });
      });
    }).once('error', reject);
  });
}

async function getJson(url) {
  const response = await get(url);
  return { ...response, body: JSON.parse(response.body) };
}

function postJson(url, payload) {
  return requestJson(url, 'POST', payload);
}

function patchJson(url, payload) {
  return requestJson(url, 'PATCH', payload);
}

function deleteJson(url) {
  return requestJson(url, 'DELETE');
}

function requestJson(url, method, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const request = http.request(url, {
      method,
      headers: body ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      } : undefined,
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        responseBody += chunk;
      });
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode,
          body: responseBody ? JSON.parse(responseBody) : undefined,
        });
      });
    });
    request.once('error', reject);
    request.end(body);
  });
}

function startMockBroker() {
  const requests = [];
  const upgrades = [];
  let origin;
  const server = http.createServer(async (req, res) => {
    const body = await readRequestJson(req);
    requests.push({ method: req.method, path: req.url, body });

    if (req.url === '/_broker/start' && req.method === 'POST') {
      const instanceId = `bkr_${body.profile}`;
      writeTestJson(res, 200, {
        ok: true,
        instanceId,
        cdpUrl: `${origin}/_broker/instances/${instanceId}`,
        profile: body.profile,
        proxyForwardId: body.proxyForwardId,
        proxyServer: body.proxyServer,
        startedAt: '2026-01-01T00:00:00.000Z',
      });
      return;
    }

    if (req.url === '/_broker/status' && req.method === 'GET') {
      writeTestJson(res, 200, { ok: true, running: true, instances: [] });
      return;
    }

    if (req.url === '/_broker/stop' && req.method === 'POST') {
      writeTestJson(res, 200, { ok: true, stopped: body.instanceId });
      return;
    }

    writeTestJson(res, 404, { ok: false, error: 'not found' });
  });
  server.on('upgrade', (req, socket) => {
    upgrades.push({ method: req.method, path: req.url });
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      '',
      'broker-upgrade-ok',
    ].join('\r\n'));
    socket.end();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      origin = `http://127.0.0.1:${address.port}`;
      resolve({
        origin,
        requests,
        upgrades,
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((error) => error ? closeReject(error) : closeResolve());
        }),
      });
    });
  });
}

function startMockProxyManager() {
  const requests = [];
  let origin;
  const server = http.createServer(async (req, res) => {
    const body = await readRequestJson(req);
    requests.push({ method: req.method, path: req.url, body });

    if (req.url === '/_proxy/status' && req.method === 'GET') {
      writeTestJson(res, 200, { ok: true, manager: true });
      return;
    }

    writeTestJson(res, 404, { ok: false, error: 'not found' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      origin = `http://127.0.0.1:${address.port}`;
      resolve({
        origin,
        requests,
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((error) => error ? closeReject(error) : closeResolve());
        }),
      });
    });
  });
}

function upgrade(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const socket = net.connect(Number(parsed.port), parsed.hostname, () => {
      socket.write([
        `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
        `Host: ${parsed.host}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Key: test',
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'));
    });
    let body = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      body += chunk;
    });
    socket.on('end', () => {
      resolve(body);
    });
    socket.once('error', reject);
  });
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      resolve(body ? JSON.parse(body) : {});
    });
    req.once('error', reject);
  });
}

function writeTestJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
  });
  res.end(body);
}

function omitStartedAt(task) {
  const { startedAt: _startedAt, ...rest } = task;
  return rest;
}
