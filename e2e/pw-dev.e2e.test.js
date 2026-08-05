import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { request } from 'playwright';

import { startPwDevServer } from '../packages/server/src/index.js';

async function json(client, method, url, body) {
  const response = await client.fetch(url, {
    method,
    data: body,
    headers: body ? { 'content-type': 'application/json' } : undefined,
  });
  return { response, payload: await response.json() };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
    req.on('error', reject);
  });
}

function startDouble(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())),
      });
    });
  });
}

async function startBrokerDouble() {
  const instances = new Set();
  const requests = [];
  let double;
  double = await startDouble(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method, path: req.url, body });
    if (req.method === 'POST' && req.url === '/_broker/start') {
      const instanceId = `bkr_${body.profile}`;
      instances.add(instanceId);
      return send(res, 200, { ok: true, instanceId, cdpUrl: `${double.origin}/_broker/instances/${instanceId}`, profile: body.profile, startedAt: '2026-01-01T00:00:00.000Z' });
    }
    if (req.method === 'POST' && req.url === '/_broker/stop') {
      instances.delete(body.instanceId);
      return send(res, 200, { ok: true, stopped: body.instanceId });
    }
    if (req.method === 'GET' && req.url === '/_broker/status') {
      return send(res, 200, {
        ok: true,
        state: instances.size ? 'active' : 'idle',
        instanceCount: instances.size,
        instances: [...instances].map((id) => ({ id })),
      });
    }
    if (req.method === 'GET' && /^\/_broker\/instances\/[^/]+\/json\/version$/.test(req.url)) {
      return send(res, 200, { Browser: 'MockChrome/1.0', webSocketDebuggerUrl: 'ws://mock/devtools/browser/mock' });
    }
    return send(res, 404, { ok: false, error: 'not found' });
  });
  return { ...double, requests };
}

async function startProxyDouble(proxies) {
  const requests = [];
  const double = await startDouble(async (req, res) => {
    requests.push({ method: req.method, path: req.url });
    const match = /^\/_proxy\/proxies\/([^/]+)\/start$/.exec(req.url || '');
    if (req.method === 'POST' && match) {
      const proxy = proxies.find((item) => item.id === decodeURIComponent(match[1]));
      if (!proxy) return send(res, 404, { ok: false, error: 'not found' });
      proxy.running = true;
      return send(res, 200, { ok: true, proxy, alreadyRunning: true });
    }
    if (req.method === 'GET' && req.url === '/_proxy/status') return send(res, 200, { ok: true, proxies });
    return send(res, 404, { ok: false, error: 'not found' });
  });
  return { ...double, requests };
}

async function makeServer(options = {}) {
  const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-e2e-'));
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>pw-dev test app</h1>');
  const broker = await startBrokerDouble();
  const server = await startPwDevServer({ root, port: 0, brokerUrl: broker.origin, ...options });
  const client = await request.newContext();
  return {
    root, broker, server, client,
    async close({ removeRoot = true } = {}) {
      await client.dispose();
      await server.close();
      await broker.close();
      if (removeRoot) fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('app verification lifecycle discovers, attaches, and cleans up a session', async () => {
  const env = await makeServer();
  try {
    const instructions = await env.client.get(`${env.server.origin}/_pwdev/instructions`);
    assert.equal(instructions.status(), 200);
    assert.match(await instructions.text(), /\/_pwdev\/apps/);
    assert.equal((await json(env.client, 'POST', `${env.server.origin}/_pwdev/apps`, { id: 'checkout', appUrl: env.server.origin })).response.status(), 200);
    assert.equal((await json(env.client, 'POST', `${env.server.origin}/_pwdev/browsers`, { id: 'checkout', appId: 'checkout', headless: true })).response.status(), 200);
    const started = await json(env.client, 'POST', `${env.server.origin}/_pwdev/browsers/checkout/start`);
    assert.equal(started.response.status(), 200);
    assert.equal(started.payload.session.sessionId, 'checkout__default');
    assert.equal(started.payload.session.cdpUrl, `${env.server.origin}/_pwdev/broker/instances/bkr_checkout`);
    const version = await env.client.get(`${started.payload.session.cdpUrl}/json/version`);
    assert.equal(version.status(), 200);
    assert.equal((await version.json()).Browser, 'MockChrome/1.0');
    assert.equal((await json(env.client, 'POST', `${env.server.origin}/_pwdev/sessions/checkout__default/stop`)).response.status(), 200);
    assert.deepEqual((await json(env.client, 'GET', `${env.server.origin}/_pwdev/sessions`)).payload.sessions, []);
  } finally { await env.close(); }
});

test('parallel named sessions stay isolated and clean up independently', async () => {
  const env = await makeServer();
  try {
    await json(env.client, 'POST', `${env.server.origin}/_pwdev/browsers`, { id: 'crawler', targetUrl: env.server.origin });
    const one = await json(env.client, 'POST', `${env.server.origin}/_pwdev/browsers/crawler/start`, { sessionId: 'worker-a' });
    const two = await json(env.client, 'POST', `${env.server.origin}/_pwdev/browsers/crawler/start`, { sessionId: 'worker-b' });
    assert.equal(one.payload.session.profile, 'crawler__worker-a');
    assert.equal(two.payload.session.profile, 'crawler__worker-b');
    assert.notEqual(one.payload.session.cdpUrl, two.payload.session.cdpUrl);
    await json(env.client, 'POST', `${env.server.origin}/_pwdev/sessions/crawler__worker-a/stop`);
    assert.deepEqual((await json(env.client, 'GET', `${env.server.origin}/_pwdev/sessions`)).payload.sessions.map((s) => s.sessionId), ['crawler__worker-b']);
    await json(env.client, 'POST', `${env.server.origin}/_pwdev/sessions/crawler__worker-b/stop`);
  } finally { await env.close(); }
});

test('exclusive proxy lease lifecycle reports exhaustion and reuses a released proxy', async () => {
  const proxies = [{ id: 'proxy-a', kind: 'whistle', proxyUrl: 'http://127.0.0.1:8888', guiUrl: 'http://127.0.0.1:9800', managed: true, running: false }];
  const manager = await startProxyDouble(proxies);
  const env = await makeServer({ proxyManagerUrl: manager.origin });
  try {
    await json(env.client, 'POST', `${env.server.origin}/_pwdev/proxies`, proxies[0]);
    await json(env.client, 'POST', `${env.server.origin}/_pwdev/browsers`, { id: 'traffic', proxyIds: ['proxy-a'] });
    const first = await json(env.client, 'POST', `${env.server.origin}/_pwdev/browsers/traffic/start`, { sessionId: 'a' });
    assert.equal(first.response.status(), 200);
    assert.equal(first.payload.proxyLease.proxyId, 'proxy-a');
    const exhausted = await json(env.client, 'POST', `${env.server.origin}/_pwdev/browsers/traffic/start`, { sessionId: 'b' });
    assert.equal(exhausted.response.status(), 409);
    await json(env.client, 'POST', `${env.server.origin}/_pwdev/sessions/traffic__a/stop`);
    const reused = await json(env.client, 'POST', `${env.server.origin}/_pwdev/browsers/traffic/start`, { sessionId: 'b' });
    assert.equal(reused.response.status(), 200);
    assert.equal(reused.payload.proxyLease.proxyId, 'proxy-a');
    assert.deepEqual(manager.requests.filter((r) => r.path.endsWith('/start')).map((r) => r.path), ['/_proxy/proxies/proxy-a/start', '/_proxy/proxies/proxy-a/start']);
  } finally { await env.close(); await manager.close(); }
});

test('durable app registration survives restart without live browser state', async () => {
  const first = await makeServer();
  const root = first.root;
  try {
    await json(first.client, 'POST', `${first.server.origin}/_pwdev/apps`, { id: 'durable-app', appUrl: first.server.origin, readme: 'Run the app devserver first.' });
  } finally { await first.close({ removeRoot: false }); }
  const second = await makeServer({ root });
  try {
    const app = await json(second.client, 'GET', `${second.server.origin}/_pwdev/apps/durable-app`);
    assert.equal(app.response.status(), 200);
    assert.equal(app.payload.app.readme, 'Run the app devserver first.');
    assert.deepEqual((await json(second.client, 'GET', `${second.server.origin}/_pwdev/sessions`)).payload.sessions, []);
  } finally { await second.close(); }
});
