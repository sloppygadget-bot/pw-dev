import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { parseArgs } from '../src/cli.js';
import { createW2Mgr, startW2MgrServer } from '../src/index.js';

test('parseArgs reads w2mgr options', () => {
  const options = parseArgs([
    '--host', '0.0.0.0',
    '--port', '18181',
    '--server-url', 'http://127.0.0.1:9696',
    '--w2-command', 'w2',
    '--proxy-port-range', '8888-8899',
    '--auto-start',
    '--quiet',
  ]);
  assert.equal(options.host, '0.0.0.0');
  assert.equal(options.port, 18181);
  assert.equal(options.serverUrl, 'http://127.0.0.1:9696');
  assert.equal(options.w2Command, 'w2');
  assert.equal(options.proxyPortRange, '8888-8899');
  assert.equal(options.autoStart, true);
  assert.equal(options.quiet, true);
});

test('manager starts and stops registered app devserver commands', async () => {
  const spawned = [];
  const registryClient = fakeRegistryClient({
    apps: [{
      id: 'checkout-tax',
      worktree: '/tmp/checkout-tax',
      devserver: {
        command: 'npm',
        args: ['run', 'dev'],
        cwd: '/tmp/checkout-tax',
        env: { PORT: '5174' },
      },
    }],
  });
  const manager = createW2Mgr({
    registryClient,
    quiet: true,
    spawnImpl: fakeSpawn(spawned),
    portAvailable: async () => true,
  });

  const started = await manager.startApp('checkout-tax');
  assert.equal(started.app.id, 'checkout-tax');
  assert.equal(started.app.running, true);
  assert.deepEqual(spawned[0].command, 'npm');
  assert.deepEqual(spawned[0].args, ['run', 'dev']);
  assert.equal(spawned[0].options.cwd, '/tmp/checkout-tax');
  assert.equal(spawned[0].options.env.PORT, '5174');

  const stopped = await manager.stopApp('checkout-tax');
  assert.equal(stopped.app.running, false);
  assert.equal(spawned[0].child.killedSignal, 'SIGTERM');
});

test('manager clears app records when child spawn fails', async () => {
  const spawned = [];
  const registryClient = fakeRegistryClient({
    apps: [{
      id: 'checkout-tax',
      devserver: {
        command: 'missing-devserver',
      },
    }],
  });
  const manager = createW2Mgr({
    registryClient,
    quiet: true,
    spawnImpl: fakeSpawn(spawned),
  });

  await manager.startApp('checkout-tax');
  spawned[0].child.emit('error', new Error('spawn ENOENT'));

  const status = await manager.status();
  assert.deepEqual(status.apps, []);
});

test('manager starts registered Whistle proxies from proxyUrl', async () => {
  const spawned = [];
  const registryClient = fakeRegistryClient({
    proxies: [{
      id: 'whistle-main',
      kind: 'whistle',
      proxyUrl: 'http://127.0.0.1:8899',
    }],
  });
  const manager = createW2Mgr({
    registryClient,
    quiet: true,
    spawnImpl: fakeSpawn(spawned),
    portAvailable: async () => true,
  });

  const started = await manager.startProxy('whistle-main');
  assert.equal(started.proxy.id, 'whistle-main');
  assert.equal(started.proxy.port, 8899);
  assert.equal(spawned[0].command, 'w2');
  assert.deepEqual(spawned[0].args, ['run', '-p', '8899']);
});

test('manager allocates Whistle proxy ports without conflicts', async () => {
  const spawned = [];
  const registryClient = fakeRegistryClient({
    proxies: [{
      id: 'whistle-a',
      proxyUrl: 'http://127.0.0.1:8888',
    }, {
      id: 'whistle-b',
      proxyUrl: 'http://127.0.0.1:8888',
    }],
  });
  const manager = createW2Mgr({
    registryClient,
    quiet: true,
    spawnImpl: fakeSpawn(spawned),
    portAvailable: async () => true,
  });

  const first = await manager.startProxy('whistle-a');
  const second = await manager.startProxy('whistle-b');

  assert.equal(first.proxy.port, 8888);
  assert.equal(second.proxy.port, 8889);
  assert.equal(second.proxy.proxyUrl, 'http://127.0.0.1:8889');
  assert.deepEqual(registryClient.updates.map((proxy) => proxy.proxyUrl), ['http://127.0.0.1:8889']);
});

test('manager skips unavailable Whistle proxy ports', async () => {
  const spawned = [];
  const registryClient = fakeRegistryClient({
    proxies: [{
      id: 'whistle-main',
      proxyUrl: 'http://127.0.0.1:8888',
    }],
  });
  const manager = createW2Mgr({
    registryClient,
    quiet: true,
    spawnImpl: fakeSpawn(spawned),
    proxyPortRange: '8888-8890',
    portAvailable: async (port) => port !== 8888,
  });

  const started = await manager.startProxy('whistle-main');

  assert.equal(started.proxy.port, 8889);
  assert.equal(started.proxy.proxyUrl, 'http://127.0.0.1:8889');
  assert.deepEqual(spawned[0].args, ['run', '-p', '8889']);
});

test('manager clears proxy records when child spawn fails', async () => {
  const spawned = [];
  const registryClient = fakeRegistryClient({
    proxies: [{
      id: 'whistle-main',
      proxyUrl: 'http://127.0.0.1:8888',
    }],
  });
  const manager = createW2Mgr({
    registryClient,
    quiet: true,
    spawnImpl: fakeSpawn(spawned),
    portAvailable: async () => true,
  });

  await manager.startProxy('whistle-main');
  spawned[0].child.emit('error', new Error('spawn ENOENT'));

  const status = await manager.status();
  assert.deepEqual(status.proxies, []);
});

test('w2mgr HTTP API starts apps and proxies', async () => {
  const spawned = [];
  const registryClient = fakeRegistryClient({
    apps: [{
      id: 'checkout-tax',
      devserver: {
        command: 'npm',
        args: ['run', 'dev'],
      },
    }],
    proxies: [{
      id: 'whistle-main',
      proxyUrl: 'http://127.0.0.1:8899',
    }],
  });
  const manager = createW2Mgr({
    registryClient,
    quiet: true,
    spawnImpl: fakeSpawn(spawned),
    portAvailable: async () => true,
  });
  const server = await startW2MgrServer({ manager, port: 0 });
  try {
    const app = await postJson(`${server.origin}/_w2mgr/apps/checkout-tax/start`, {});
    assert.equal(app.statusCode, 200);
    assert.equal(app.body.app.id, 'checkout-tax');

    const proxy = await postJson(`${server.origin}/_w2mgr/proxies/whistle-main/start`, {});
    assert.equal(proxy.statusCode, 200);
    assert.equal(proxy.body.proxy.port, 8899);

    const status = await getJson(`${server.origin}/_w2mgr/status`);
    assert.equal(status.statusCode, 200);
    assert.deepEqual(status.body.apps.map((record) => record.id), ['checkout-tax']);
    assert.deepEqual(status.body.proxies.map((record) => record.id), ['whistle-main']);
  } finally {
    await server.close();
  }
});

function fakeRegistryClient({ apps = [], proxies = [] } = {}) {
  const client = {
    updates: [],
    async listApps() {
      return apps;
    },
    async getApp(id) {
      return apps.find((app) => app.id === id);
    },
    async listProxies() {
      return proxies;
    },
    async getProxy(id) {
      return proxies.find((proxy) => proxy.id === id);
    },
    async updateProxy(proxy) {
      this.updates.push(proxy);
      const index = proxies.findIndex((candidate) => candidate.id === proxy.id);
      if (index === -1) proxies.push(proxy);
      else proxies[index] = proxy;
      return proxy;
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
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = http.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
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
