import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { request } from 'playwright';

import { startPwDevServer } from '../packages/server/src/index.js';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function createOpenApiContract(prefix, documentPaths) {
  const documents = documentPaths.map((documentPath) => JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, documentPath), 'utf8')));
  return {
    assertResponse(method, rawUrl, status, body) {
      const pathname = new URL(rawUrl, 'http://pw-dev.test').pathname;
      assert.ok(pathname.startsWith(prefix), `mocked ${method} ${pathname} is outside ${prefix}`);
      const apiPath = pathname.slice(prefix.length) || '/';
      const operation = findOperation(documents, method, apiPath);
      assert.ok(operation, `mocked ${method} ${apiPath} is not documented in ${prefix} OpenAPI`);
      const response = operation.definition.responses?.[String(status)];
      assert.ok(response, `mocked ${method} ${apiPath} returned undocumented HTTP ${status}`);
      const schema = response.content?.['application/json']?.schema;
      assert.ok(schema, `mocked ${method} ${apiPath} HTTP ${status} has no JSON response schema`);
      assertJsonSchema(body, operation.document, schema, `${method} ${apiPath} HTTP ${status}`);
    },
  };
}

function findOperation(documents, method, actualPath) {
  const normalizedMethod = method.toLowerCase();
  for (const document of documents) {
    for (const [template, pathItem] of Object.entries(document.paths ?? {})) {
      if (!pathMatches(template, actualPath)) continue;
      if (pathItem[normalizedMethod]) return { document, definition: pathItem[normalizedMethod] };
    }
  }
  return undefined;
}

function pathMatches(template, actualPath) {
  const expected = template.split('/').filter(Boolean);
  const actual = actualPath.split('/').filter(Boolean);
  return expected.length === actual.length && expected.every((part, index) => /^\{[^}]+\}$/.test(part) || part === actual[index]);
}

function resolveSchema(document, schema) {
  if (!schema.$ref) return schema;
  assert.match(schema.$ref, /^#\/components\/schemas\/[A-Za-z0-9._-]+$/);
  const name = schema.$ref.split('/').at(-1);
  const resolved = document.components?.schemas?.[name];
  assert.ok(resolved, `OpenAPI schema ${schema.$ref} is missing`);
  return resolveSchema(document, resolved);
}

function assertJsonSchema(value, document, schema, context) {
  schema = resolveSchema(document, schema);
  if (schema.type === 'object') {
    assert.equal(typeof value, 'object', `${context} must be an object`);
    assert.notEqual(value, null, `${context} must not be null`);
    for (const name of schema.required ?? []) assert.ok(name in value, `${context} is missing required property ${name}`);
    for (const [name, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (value[name] !== undefined) assertJsonSchema(value[name], document, propertySchema, `${context}.${name}`);
    }
  } else if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${context} must be an array`);
    if (schema.items) value.forEach((item, index) => assertJsonSchema(item, document, schema.items, `${context}[${index}]`));
  } else if (schema.type === 'string') {
    assert.equal(typeof value, 'string', `${context} must be a string`);
  } else if (schema.type === 'integer') {
    assert.ok(Number.isInteger(value), `${context} must be an integer`);
  } else if (schema.type === 'boolean') {
    assert.equal(typeof value, 'boolean', `${context} must be a boolean`);
  } else {
    assert.fail(`${context} uses unsupported schema type ${schema.type ?? 'unknown'}`);
  }
}

function send(req, res, contract, status, body) {
  contract.assertResponse(req.method, req.url, status, body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function json(client, method, url, body) {
  const response = await client.fetch(url, {
    method,
    data: body,
    headers: body ? { 'content-type': 'application/json' } : undefined,
  });
  return { response, payload: await response.json() };
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
  const contract = createOpenApiContract('/_broker', ['packages/cdp-broker/openapi/root.json']);
  const instances = new Set();
  const requests = [];
  let double;
  double = await startDouble(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method, path: req.url, body });
    if (req.method === 'POST' && req.url === '/_broker/start') {
      const instanceId = `bkr_${body.profile}`;
      instances.add(instanceId);
      return send(req, res, contract, 200, { ok: true, instanceId, cdpUrl: `${double.origin}/_broker/instances/${instanceId}`, profile: body.profile, startedAt: '2026-01-01T00:00:00.000Z' });
    }
    if (req.method === 'POST' && req.url === '/_broker/stop') {
      instances.delete(body.instanceId);
      return send(req, res, contract, 200, { ok: true, stopped: body.instanceId });
    }
    if (req.method === 'POST' && req.url === '/_broker/profiles/clear') {
      return send(req, res, contract, 200, { ok: true, profile: body.profile, cleared: true });
    }
    if (req.method === 'GET' && req.url === '/_broker/status') {
      return send(req, res, contract, 200, {
        ok: true,
        state: instances.size ? 'active' : 'idle',
        instanceCount: instances.size,
        instances: [...instances].map((id) => ({ id })),
      });
    }
    if (req.method === 'GET' && /^\/_broker\/instances\/[^/]+\/json\/version$/.test(req.url)) {
      return send(req, res, contract, 200, { Browser: 'MockChrome/1.0', webSocketDebuggerUrl: 'ws://mock/devtools/browser/mock' });
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });
  return { ...double, requests };
}

async function startProxyDouble(proxies) {
  const contract = createOpenApiContract('/_proxy', ['packages/proxy/openapi/root.json', 'packages/proxy/openapi/lifecycle.json']);
  const requests = [];
  const double = await startDouble(async (req, res) => {
    requests.push({ method: req.method, path: req.url });
    const match = /^\/_proxy\/proxies\/([^/]+)\/start$/.exec(req.url || '');
    if (req.method === 'POST' && match) {
      const proxy = proxies.find((item) => item.id === decodeURIComponent(match[1]));
      if (!proxy) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'not found' }));
      }
      proxy.running = true;
      return send(req, res, contract, 200, { ok: true, proxy, alreadyRunning: true });
    }
    if (req.method === 'GET' && req.url === '/_proxy/status') return send(req, res, contract, 200, { ok: true, proxies });
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });
  return { ...double, requests };
}

test('OpenAPI-backed doubles reject response shape drift', () => {
  const broker = createOpenApiContract('/_broker', ['packages/cdp-broker/openapi/root.json']);
  assert.throws(
    () => broker.assertResponse('GET', '/_broker/status', 200, { ok: true }),
    /missing required property state/
  );
});

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
    assert.equal((await json(env.client, 'POST', `${env.server.origin}/_pwdev/browser-configs`, { id: 'checkout-config', headless: true })).response.status(), 200);
    assert.equal((await json(env.client, 'POST', `${env.server.origin}/_pwdev/browsers`, { id: 'checkout', browserConfigId: 'checkout-config', appId: 'checkout' })).response.status(), 200);
    const started = await json(env.client, 'POST', `${env.server.origin}/_pwdev/browsers/checkout/start`);
    assert.equal(started.response.status(), 200);
    assert.equal(started.payload.session.sessionId, 'checkout__default');
    assert.equal(started.payload.session.cdpUrl, `${env.server.origin}/_pwdev/broker/instances/bkr_checkout-config__checkout`);
    const version = await env.client.get(`${started.payload.session.cdpUrl}/json/version`);
    assert.equal(version.status(), 200);
    assert.equal((await version.json()).Browser, 'MockChrome/1.0');
    assert.equal((await json(env.client, 'POST', `${env.server.origin}/_pwdev/sessions/checkout__default/stop`)).response.status(), 200);
    assert.deepEqual((await json(env.client, 'GET', `${env.server.origin}/_pwdev/sessions`)).payload.sessions, []);
  } finally { await env.close(); }
});

test('parallel browsers sharing one config stay isolated and clean up independently', async () => {
  const env = await makeServer();
  try {
    await json(env.client, 'POST', `${env.server.origin}/_pwdev/browser-configs`, { id: 'crawler', targetUrl: env.server.origin });
    await json(env.client, 'POST', `${env.server.origin}/_pwdev/browsers`, { id: 'worker-a', browserConfigId: 'crawler' });
    await json(env.client, 'POST', `${env.server.origin}/_pwdev/browsers`, { id: 'worker-b', browserConfigId: 'crawler' });
    const one = await json(env.client, 'POST', `${env.server.origin}/_pwdev/browsers/worker-a/start`);
    const two = await json(env.client, 'POST', `${env.server.origin}/_pwdev/browsers/worker-b/start`);
    assert.equal(one.payload.session.profile, 'crawler__worker-a');
    assert.equal(two.payload.session.profile, 'crawler__worker-b');
    assert.notEqual(one.payload.session.cdpUrl, two.payload.session.cdpUrl);
    await json(env.client, 'POST', `${env.server.origin}/_pwdev/sessions/worker-a__default/stop`);
    assert.deepEqual((await json(env.client, 'GET', `${env.server.origin}/_pwdev/sessions`)).payload.sessions.map((s) => s.sessionId), ['worker-b__default']);
    await json(env.client, 'POST', `${env.server.origin}/_pwdev/sessions/worker-b__default/stop`);
  } finally { await env.close(); }
});

test('exclusive proxy lease lifecycle reports exhaustion and reuses a released proxy', async () => {
  const proxies = [{ id: 'proxy-a', kind: 'whistle', proxyUrl: 'http://127.0.0.1:8888', guiUrl: 'http://127.0.0.1:9800', managed: true, running: false }];
  const manager = await startProxyDouble(proxies);
  const env = await makeServer({ proxyManagerUrl: manager.origin });
  try {
    await json(env.client, 'POST', `${env.server.origin}/_pwdev/proxies`, proxies[0]);
    await json(env.client, 'POST', `${env.server.origin}/_pwdev/browser-configs`, { id: 'traffic' });
    await json(env.client, 'POST', `${env.server.origin}/_pwdev/browsers`, { id: 'traffic-a', browserConfigId: 'traffic', proxyIds: ['proxy-a'] });
    await json(env.client, 'POST', `${env.server.origin}/_pwdev/browsers`, { id: 'traffic-b', browserConfigId: 'traffic', proxyIds: ['proxy-a'] });
    const first = await json(env.client, 'POST', `${env.server.origin}/_pwdev/browsers/traffic-a/start`);
    assert.equal(first.response.status(), 200);
    assert.equal(first.payload.session.proxyId, 'proxy-a');
    const exhausted = await json(env.client, 'POST', `${env.server.origin}/_pwdev/browsers/traffic-b/start`);
    assert.equal(exhausted.response.status(), 409);
    await json(env.client, 'DELETE', `${env.server.origin}/_pwdev/browsers/traffic-a`);
    const reused = await json(env.client, 'POST', `${env.server.origin}/_pwdev/browsers/traffic-b/start`);
    assert.equal(reused.response.status(), 200);
    assert.equal(reused.payload.session.proxyId, 'proxy-a');
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
