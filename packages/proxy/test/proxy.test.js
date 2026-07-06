import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseArgs } from '../src/cli.js';
import { createProxyManager, startProxyManagerServer } from '../src/index.js';

test('parseArgs reads proxy options', () => {
  const options = parseArgs([
    '--host', '0.0.0.0',
    '--port', '18181',
    '--server-url', 'http://127.0.0.1:9696',
    '--w2-command', 'w2',
    '--w2-storage-root', '/tmp/pw-dev-proxy-test',
    '--proxy-port-range', '8888-8899',
    '--ui-port-range', '9800-9899',
    '--quiet',
  ]);
  assert.equal(options.host, '0.0.0.0');
  assert.equal(options.port, 18181);
  assert.equal(options.serverUrl, 'http://127.0.0.1:9696');
  assert.equal(options.w2Command, 'w2');
  assert.equal(options.w2StorageRoot, '/tmp/pw-dev-proxy-test');
  assert.equal(options.proxyPortRange, '8888-8899');
  assert.equal(options.uiPortRange, '9800-9899');
  assert.equal(options.quiet, true);
});

test('manager defaults Whistle storage under proxy runtime root', async () => {
  const manager = createProxyManager({
    registryClient: fakeRegistryClient(),
    quiet: true,
  });
  const status = await manager.status();
  assert.equal(status.w2StorageRoot, path.resolve('packages/proxy/.runtime/whistle'));
  assert.equal(status.whistleCommand, process.execPath);
  assert.match(status.whistleArgsPrefix[0], /whistle[/\\]bin[/\\]whistle\.js$/);
});

test('manager creates Whistle instance from ruleset and attaches it to app', async () => {
  const spawned = [];
  const w2StorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-proxy-test-'));
  const registryClient = fakeRegistryClient({
    apps: [{ id: 'react-login', appUrl: 'http://127.0.0.1:5173' }],
  });
  const manager = createProxyManager({
    registryClient,
    quiet: true,
    spawnImpl: fakeSpawn(spawned),
    w2StorageRoot,
    proxyPortRange: '8899-8899',
    uiPortRange: '9801-9801',
    portAvailable: async () => true,
  });

  try {
    const created = await manager.createProxy({
      id: 'react-login-capture',
      appId: 'react-login',
      name: 'React login capture',
      taskId: 'smoke-login-20260703',
      owner: 'codex',
      purpose: 'Capture login traffic',
      labels: ['smoke', 'login'],
      ruleset: 'www.example.com 127.0.0.1:3000',
    });

    assert.equal(created.proxy.id, 'react-login-capture');
    assert.equal(created.proxy.proxyPort, 8899);
    assert.equal(created.proxy.uiPort, 9801);
    assert.equal(created.proxy.proxyUrl, 'http://127.0.0.1:8899');
    assert.equal(created.proxy.guiUrl, 'http://127.0.0.1:9801');
    assert.equal(created.proxy.taskId, 'smoke-login-20260703');
    assert.equal(created.proxy.owner, 'codex');
    assert.equal(created.proxy.purpose, 'Capture login traffic');
    assert.deepEqual(created.proxy.labels, ['smoke', 'login']);
    assert.equal(created.app.proxyId, 'react-login-capture');
    assert.equal(fs.readFileSync(created.proxy.rulesetFile, 'utf8'), 'www.example.com 127.0.0.1:3000');
    assert.equal(spawned[0].command, process.execPath);
    assert.match(spawned[0].args[0], /whistle[/\\]bin[/\\]whistle\.js$/);
    assert.deepEqual(spawned[0].args.slice(1), [
      'run',
      '-p',
      '8899',
      '--uiport',
      '9801',
      '-S',
      created.proxy.storageDir,
      '-r',
      'www.example.com 127.0.0.1:3000',
    ]);
    assert.deepEqual(registryClient.updates[0], {
      id: 'react-login-capture',
      kind: 'whistle',
      name: 'React login capture',
      appId: 'react-login',
      taskId: 'smoke-login-20260703',
      owner: 'codex',
      purpose: 'Capture login traffic',
      labels: ['smoke', 'login'],
      proxyUrl: 'http://127.0.0.1:8899',
      guiUrl: 'http://127.0.0.1:9801',
      rulesetFile: created.proxy.rulesetFile,
      managed: true,
    });
    assert.deepEqual(registryClient.appPatches, [{
      id: 'react-login',
      patch: { proxyId: 'react-login-capture' },
    }]);

    await manager.deleteProxy('react-login-capture');
    assert.equal(spawned[0].child.killedSignal, 'SIGTERM');
    assert.equal(fs.existsSync(created.proxy.storageDir), false);
    assert.deepEqual(registryClient.deletes, ['react-login-capture']);
    assert.deepEqual(registryClient.appPatches, [{
      id: 'react-login',
      patch: { proxyId: 'react-login-capture' },
    }, {
      id: 'react-login',
      patch: { proxyId: null },
    }]);
  } finally {
    fs.rmSync(w2StorageRoot, { recursive: true, force: true });
  }
});

test('manager accepts explicit Whistle command override', async () => {
  const spawned = [];
  const manager = createProxyManager({
    registryClient: fakeRegistryClient(),
    quiet: true,
    spawnImpl: fakeSpawn(spawned),
    w2Command: 'w2',
    portAvailable: async () => true,
  });

  await manager.createProxy({ id: 'override', ruleset: 'a b' });
  assert.equal(spawned[0].command, 'w2');
  assert.deepEqual(spawned[0].args.slice(0, 3), ['run', '-p', '8888']);
  assert.deepEqual(spawned[0].args.slice(-2), ['-r', 'a b']);
  await manager.stopAll();
});

test('manager writes object ruleset as JSON', async () => {
  const spawned = [];
  const w2StorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-proxy-test-'));
  const manager = createProxyManager({
    registryClient: fakeRegistryClient(),
    quiet: true,
    spawnImpl: fakeSpawn(spawned),
    w2StorageRoot,
    portAvailable: async () => true,
  });

  try {
    const created = await manager.createProxy({
      id: 'api-rules',
      ruleset: { rules: [{ pattern: '/api', target: 'http://127.0.0.1:3000' }] },
    });
    assert.equal(path.basename(created.proxy.rulesetFile), 'ruleset.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(created.proxy.rulesetFile, 'utf8')), {
      rules: [{ pattern: '/api', target: 'http://127.0.0.1:3000' }],
    });
  } finally {
    await manager.stopAll();
    fs.rmSync(w2StorageRoot, { recursive: true, force: true });
  }
});

test('manager rejects duplicate managed proxy ids', async () => {
  const manager = createProxyManager({
    registryClient: fakeRegistryClient(),
    quiet: true,
    spawnImpl: fakeSpawn([]),
    portAvailable: async () => true,
  });

  await manager.createProxy({ id: 'dup', ruleset: 'a b' });
  await assert.rejects(
    () => manager.createProxy({ id: 'dup', ruleset: 'a b' }),
    /Managed proxy already exists/
  );
  await manager.stopAll();
});

test('manager clears proxy records when child spawn fails', async () => {
  const spawned = [];
  const manager = createProxyManager({
    registryClient: fakeRegistryClient(),
    quiet: true,
    spawnImpl: fakeSpawn(spawned),
    portAvailable: async () => true,
  });

  await manager.createProxy({ id: 'whistle-main', ruleset: 'a b' });
  spawned[0].child.emit('error', new Error('spawn ENOENT'));

  const status = await manager.status();
  assert.deepEqual(status.proxies, []);
  assert.deepEqual(manager.serverUrl, 'http://127.0.0.1:9696');
});

test('proxy HTTP API creates, reads, and deletes managed proxies', async () => {
  const spawned = [];
  const manager = createProxyManager({
    registryClient: fakeRegistryClient(),
    quiet: true,
    spawnImpl: fakeSpawn(spawned),
    portAvailable: async () => true,
  });
  const server = await startProxyManagerServer({ manager, port: 0 });
  try {
    const created = await postJson(`${server.origin}/_proxy/proxies`, {
      id: 'whistle-main',
      ruleset: 'a b',
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.body.proxy.id, 'whistle-main');

    const read = await getJson(`${server.origin}/_proxy/proxies/whistle-main`);
    assert.equal(read.statusCode, 200);
    assert.equal(read.body.proxy.proxyUrl, created.body.proxy.proxyUrl);

    const status = await getJson(`${server.origin}/_proxy/status`);
    assert.equal(status.statusCode, 200);
    assert.deepEqual(status.body.proxies.map((record) => record.id), ['whistle-main']);

    const deleted = await deleteJson(`${server.origin}/_proxy/proxies/whistle-main`);
    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.body.proxy.running, false);
  } finally {
    await server.close();
  }
});

function fakeRegistryClient({ apps = [] } = {}) {
  const client = {
    updates: [],
    deletes: [],
    appPatches: [],
    apps,
    async updateProxy(proxy) {
      this.updates.push(proxy);
      return proxy;
    },
    async updateApp(id, patch) {
      this.appPatches.push({ id, patch });
      const app = this.apps.find((candidate) => candidate.id === id);
      if (!app) throw new Error(`Unknown app: ${id}`);
      Object.assign(app, patch);
      return app;
    },
    async deleteProxy(id) {
      this.deletes.push(id);
    },
  };
  return client;
}

function fakeSpawn(spawned) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 1234 + spawned.length;
    child.kill = (signal) => {
      child.killedSignal = signal;
      child.emit('exit', null, signal);
    };
    child.once = child.once.bind(child);
    spawned.push({ command, args, options, child });
    return child;
  };
}

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
        resolve({ statusCode: response.statusCode, body: JSON.parse(responseBody) });
      });
    });
    request.once('error', reject);
    request.end(body);
  });
}
