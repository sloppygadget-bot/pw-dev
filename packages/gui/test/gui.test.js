import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { parseArgs } from '../src/cli.js';
import { resolveStaticPath, startPwDevGuiServer } from '../src/server.js';

test('parseArgs reads gui options', () => {
  const options = parseArgs([
    '--host', '0.0.0.0',
    '--port', '4777',
    '--pwdev-url', 'http://127.0.0.1:9696',
    '--broker-url', 'http://127.0.0.1:18080',
    '--proxy-manager-url', 'http://127.0.0.1:18081',
  ]);

  assert.equal(options.host, '0.0.0.0');
  assert.equal(options.port, 4777);
  assert.equal(options.pwDevUrl, 'http://127.0.0.1:9696');
  assert.equal(options.brokerUrl, 'http://127.0.0.1:18080');
  assert.equal(options.proxyManagerUrl, 'http://127.0.0.1:18081');
});

test('resolveStaticPath keeps gui static requests under root', () => {
  assert.equal(resolveStaticPath('/tmp/gui', '/index.html'), '/tmp/gui/index.html');
  assert.equal(resolveStaticPath('/tmp/gui', '/../secret'), '/tmp/gui/secret');
});

test('gui serves static app and read-only config', async () => {
  const server = await startPwDevGuiServer({
    port: 0,
    pwDevUrl: 'http://127.0.0.1:9696',
    brokerUrl: 'http://127.0.0.1:18080',
    proxyManagerUrl: 'http://127.0.0.1:18081',
  });

  try {
    const index = await get(`${server.origin}/`);
    assert.equal(index.statusCode, 200);
    assert.match(index.body, /pw-dev Monitor/);

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

test('gui snapshot collects from server, broker, and proxy manager', async () => {
  const pwdev = await startJsonServer({
    '/_pwdev/status': {
      ok: true,
      serverUrl: 'http://127.0.0.1:9696',
      broker: { configured: true, reachable: true },
      manifest: { ok: true, id: 'main' },
    },
    '/_pwdev/apps': { ok: true, apps: [{ id: 'main', networkId: 'agent-whistle' }] },
    '/_pwdev/proxies': { ok: true, proxies: [{ id: 'proxy-main' }] },
    '/_pwdev/networks': { ok: true, networks: [{ id: 'agent-whistle' }] },
  });
  const broker = await startJsonServer({
    '/_broker/status': {
      ok: true,
      running: true,
      topology: { mode: 'local', remote: false },
      instances: [{ id: 'bkr_1', networkId: 'agent-whistle' }],
    },
    '/_broker/networks': { ok: true, networks: [{ id: 'agent-whistle', inUseBy: ['bkr_1'] }] },
    '/_broker/proxy-forwards': { ok: true, forwards: [] },
  });
  const proxy = await startJsonServer({
    '/_proxy/status': { ok: true, proxies: [{ id: 'proxy-main' }] },
  });
  const gui = await startPwDevGuiServer({
    port: 0,
    pwDevUrl: pwdev.origin,
    brokerUrl: broker.origin,
    proxyManagerUrl: proxy.origin,
  });

  try {
    const snapshot = await getJson(`${gui.origin}/api/snapshot`);
    assert.equal(snapshot.statusCode, 200);
    assert.equal(snapshot.body.ok, true);
    assert.equal(snapshot.body.server.apps.body.apps[0].id, 'main');
    assert.equal(snapshot.body.broker.status.body.running, true);
    assert.equal(snapshot.body.proxyManager.status.body.proxies[0].id, 'proxy-main');
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
    '/_pwdev/proxies': { ok: true, proxies: [] },
    '/_pwdev/networks': { ok: true, networks: [] },
  });
  const broker = await startJsonServer({
    '/_broker/status': { ok: true, running: false, instances: [] },
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

function startJsonServer(routes) {
  const server = http.createServer((req, res) => {
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
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((error) => error ? closeReject(error) : closeResolve());
        }),
      });
    });
  });
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
