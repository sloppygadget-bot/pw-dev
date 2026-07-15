import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createNetworkManager } from '../src/networks.js';
import { createBrokerServer, rewriteDebuggerUrls } from '../src/server.js';

test('rewrites browser and page websocket debugger urls to broker origin', () => {
  const payload = {
    webSocketDebuggerUrl: 'ws://127.0.0.1:41235/devtools/browser/abc',
    pages: [
      {
        webSocketDebuggerUrl: 'ws://127.0.0.1:41235/devtools/page/def',
      },
    ],
  };

  assert.deepEqual(rewriteDebuggerUrls(payload, 'http://127.0.0.1:18080'), {
    webSocketDebuggerUrl: 'ws://127.0.0.1:18080/devtools/browser/abc',
    pages: [
      {
        webSocketDebuggerUrl: 'ws://127.0.0.1:18080/devtools/page/def',
      },
    ],
  });
});

test('uses wss when broker origin is https', () => {
  const payload = {
    webSocketDebuggerUrl: 'ws://127.0.0.1:41235/devtools/browser/abc',
  };

  assert.equal(
    rewriteDebuggerUrls(payload, 'https://broker.example.test').webSocketDebuggerUrl,
    'wss://broker.example.test/devtools/browser/abc'
  );
});

test('rewrites debugger urls under an instance-scoped broker path', () => {
  const payload = {
    webSocketDebuggerUrl: 'ws://127.0.0.1:41235/devtools/browser/abc',
  };

  assert.equal(
    rewriteDebuggerUrls(
      payload,
      'http://127.0.0.1:18080/_broker/instances/bkr_abc'
    ).webSocketDebuggerUrl,
    'ws://127.0.0.1:18080/_broker/instances/bkr_abc/devtools/browser/abc'
  );
});

test('start control route returns an instance-scoped CDP URL', async () => {
  const starts = [];
  const server = createBrokerServer({
    browserManager: {
      activeInstance: () => undefined,
      listInstances: () => [],
      start: async (options) => {
        starts.push(options);
        return {
          id: 'bkr_abc',
          profile: 'work-okta',
          chromeHost: '127.0.0.1',
          chromePort: 9333,
          pid: 123,
          startedAt: '2026-06-16T00:00:00.000Z',
        };
      },
    },
  });

  const { port, close } = await listen(server);
  try {
    const response = await requestJson({
      port,
      method: 'POST',
      path: '/_broker/start',
      body: {
        profile: 'work-okta',
        proxyServer: 'http://127.0.0.1:18899',
        ignoreSslErrors: true,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(starts, [
      {
        profile: 'work-okta',
        proxyServer: 'http://127.0.0.1:18899',
        ignoreSslErrors: true,
      },
    ]);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.instanceId, 'bkr_abc');
    assert.equal(
      response.body.cdpUrl,
      `http://127.0.0.1:${port}/_broker/instances/bkr_abc`
    );
  } finally {
    await close();
  }
});

test('start control route resolves proxyForwardId to proxyServer', async () => {
  const starts = [];
  const server = createBrokerServer({
    browserManager: {
      activeInstance: () => undefined,
      listInstances: () => [],
      start: async (options) => {
        starts.push(options);
        return {
          id: 'bkr_abc',
          profile: 'work-okta',
          chromeHost: '127.0.0.1',
          chromePort: 9333,
          proxyForwardId: options.proxyForwardId,
          proxyServer: options.proxyServer,
          pid: 123,
          startedAt: '2026-06-16T00:00:00.000Z',
        };
      },
    },
    proxyForwardManager: {
      get: () => ({
        forwardId: 'pf_abc',
        proxyServer: 'http://127.0.0.1:18899',
      }),
    },
  });

  const { port, close } = await listen(server);
  try {
    const response = await requestJson({
      port,
      method: 'POST',
      path: '/_broker/start',
      body: {
        profile: 'work-okta',
        proxyForwardId: 'pf_abc',
        ignoreSslErrors: true,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(starts, [
      {
        profile: 'work-okta',
        proxyForwardId: 'pf_abc',
        ignoreSslErrors: true,
        proxyServer: 'http://127.0.0.1:18899',
      },
    ]);
    assert.equal(response.body.proxyForwardId, 'pf_abc');
    assert.equal(response.body.proxyServer, 'http://127.0.0.1:18899');
  } finally {
    await close();
  }
});

test('start control route rejects proxyServer with proxyForwardId', async () => {
  const server = createBrokerServer({
    browserManager: {
      activeInstance: () => undefined,
      listInstances: () => [],
      start: async () => {
        throw new Error('should not start');
      },
    },
  });

  const { port, close } = await listen(server);
  try {
    const response = await requestJson({
      port,
      method: 'POST',
      path: '/_broker/start',
      body: {
        profile: 'work-okta',
        proxyForwardId: 'pf_abc',
        proxyServer: 'http://127.0.0.1:18899',
      },
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.body.error, /mutually exclusive/);
  } finally {
    await close();
  }
});

test('status reports local broker topology by default', async () => {
  const server = createBrokerServer({
    browserManager: {
      activeInstance: () => undefined,
      listInstances: () => [],
    },
  });

  const { port, close } = await listen(server);
  try {
    const response = await requestJson({
      port,
      method: 'GET',
      path: '/_broker/status',
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.state, 'idle');
    assert.equal(response.body.instanceCount, 0);
    assert.deepEqual(response.body.topology, { mode: 'local', remote: false });
  } finally {
    await close();
  }
});

test('status reports SSH remote broker topology', async () => {
  const server = createBrokerServer({
    browserManager: {
      activeInstance: () => undefined,
      listInstances: () => [],
    },
    topology: {
      mode: 'ssh',
      remote: true,
      ssh: {
        target: 'user@code-server',
        remotePort: 18080,
        controlPersist: '24h',
        remoteMachine: {
          hostname: 'code-server',
          addresses: ['10.11.2.10'],
          platform: 'Linux',
          release: '6.8.0',
        },
      },
    },
  });

  const { port, close } = await listen(server);
  try {
    const response = await requestJson({
      port,
      method: 'GET',
      path: '/_broker/status',
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.state, 'idle');
    assert.equal(response.body.instanceCount, 0);
    assert.equal(response.body.topology.mode, 'ssh');
    assert.equal(response.body.topology.remote, true);
    assert.deepEqual(response.body.topology.ssh, {
      target: 'user@code-server',
      remotePort: 18080,
      controlPersist: '24h',
      remoteMachine: {
        hostname: 'code-server',
        addresses: ['10.11.2.10'],
        platform: 'Linux',
        release: '6.8.0',
      },
    });
  } finally {
    await close();
  }
});

test('returns 503 for CDP discovery before Chrome is started', async () => {
  const server = createBrokerServer({
    browserManager: {
      activeInstance: () => undefined,
      listInstances: () => [],
    },
  });

  const { port, close } = await listen(server);
  try {
    const response = await requestJson({
      port,
      method: 'GET',
      path: '/json/version',
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.body.ok, false);
    assert.match(response.body.error, /Chrome is not running/);
  } finally {
    await close();
  }
});

test('returns 409 for root CDP discovery when multiple instances are running', async () => {
  const error = new Error('Multiple Chrome instances are running; use an instance-scoped cdpUrl');
  error.statusCode = 409;
  const server = createBrokerServer({
    browserManager: {
      activeInstance: () => {
        throw error;
      },
      listInstances: () => [
        { id: 'bkr_a', chromeHost: '127.0.0.1', chromePort: 9333 },
        { id: 'bkr_b', chromeHost: '127.0.0.1', chromePort: 9334 },
      ],
    },
  });

  const { port, close } = await listen(server);
  try {
    const response = await requestJson({
      port,
      method: 'GET',
      path: '/json/version',
    });

    assert.equal(response.statusCode, 409);
    assert.match(response.body.error, /Multiple Chrome instances/);
  } finally {
    await close();
  }
});

test('routes instance-scoped CDP discovery to the selected Chrome instance', async () => {
  const chromeA = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:${chromeA.address().port}/devtools/browser/a`,
      })
    );
  });
  const chromeB = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:${chromeB.address().port}/devtools/browser/b`,
      })
    );
  });
  const a = await listen(chromeA);
  const b = await listen(chromeB);
  const server = createBrokerServer({
    browserManager: {
      getInstance: (id) => ({
        bkr_a: { id: 'bkr_a', chromeHost: '127.0.0.1', chromePort: a.port },
        bkr_b: { id: 'bkr_b', chromeHost: '127.0.0.1', chromePort: b.port },
      })[id],
      activeInstance: () => undefined,
      listInstances: () => [],
    },
  });

  const broker = await listen(server);
  try {
    const responseA = await requestJson({
      port: broker.port,
      method: 'GET',
      path: '/_broker/instances/bkr_a/json/version',
    });
    const responseB = await requestJson({
      port: broker.port,
      method: 'GET',
      path: '/_broker/instances/bkr_b/json/version',
    });

    assert.equal(
      responseA.body.webSocketDebuggerUrl,
      `ws://127.0.0.1:${broker.port}/_broker/instances/bkr_a/devtools/browser/a`
    );
    assert.equal(
      responseB.body.webSocketDebuggerUrl,
      `ws://127.0.0.1:${broker.port}/_broker/instances/bkr_b/devtools/browser/b`
    );
  } finally {
    await broker.close();
    await a.close();
    await b.close();
  }
});

test('serves remote Playwright help over broker endpoints', async () => {
  const server = createBrokerServer({
    browserManager: {
      activeInstance: () => undefined,
      listInstances: () => [],
    },
  });

  const { port, close } = await listen(server);
  try {
    const help = await requestText({
      port,
      method: 'GET',
      path: '/_broker/help',
    });
    const instructions = await requestText({
      port,
      method: 'GET',
      path: '/_broker/instructions',
    });

    assert.equal(help.statusCode, 200);
    assert.match(help.headers['content-type'], /text\/markdown/);
    assert.match(help.body, new RegExp(`http://127\\.0\\.0\\.1:${port}`));
    assert.match(help.body, /POST \/_broker\/start|_broker\/start/);
    assert.match(help.body, /_broker\/profiles\/clear/);
    assert.match(help.body, /_broker\/networks/);
    assert.match(help.body, /networkId/);
    assert.match(help.body, /proxyForwardId/);
    assert.match(help.body, /connectOverCDP\(start\.cdpUrl\)/);
    assert.equal(instructions.body, help.body);
  } finally {
    await close();
  }
});

test('serves proxy forward lifecycle endpoints', async () => {
  const creates = [];
  const deletes = [];
  const server = createBrokerServer({
    browserManager: {
      activeInstance: () => undefined,
      listInstances: () => [{ id: 'bkr_1', proxyForwardId: 'pf_in_use' }],
    },
    proxyForwardManager: {
      create: async (options) => {
        creates.push(options);
        return {
          forwardId: 'pf_abc',
          remotePort: options.remotePort,
          localPort: 18899,
          proxyServer: 'http://127.0.0.1:18899',
          createdAt: '2026-06-16T00:00:00.000Z',
          inUseBy: [],
        };
      },
      list: (instances) => [
        {
          forwardId: 'pf_in_use',
          remotePort: 8899,
          localPort: 18899,
          proxyServer: 'http://127.0.0.1:18899',
          createdAt: '2026-06-16T00:00:00.000Z',
          inUseBy: instances.map((instance) => instance.id),
        },
      ],
      delete: (forwardId, instances) => {
        deletes.push({ forwardId, instances });
        return { deleted: true, forwardId };
      },
    },
  });

  const { port, close } = await listen(server);
  try {
    const create = await requestJson({
      port,
      method: 'POST',
      path: '/_broker/proxy-forwards',
      body: { name: 'whistle', remotePort: 8899 },
    });
    const list = await requestJson({
      port,
      method: 'GET',
      path: '/_broker/proxy-forwards',
    });
    const deleted = await requestJson({
      port,
      method: 'DELETE',
      path: '/_broker/proxy-forwards/pf_abc',
    });

    assert.equal(create.statusCode, 200);
    assert.deepEqual(creates, [{ name: 'whistle', remotePort: 8899 }]);
    assert.equal(create.body.proxyServer, 'http://127.0.0.1:18899');
    assert.equal(list.body.forwards[0].inUseBy[0], 'bkr_1');
    assert.equal(deleted.statusCode, 200);
    assert.deepEqual(deletes[0].forwardId, 'pf_abc');
  } finally {
    await close();
  }
});

test('serves network lifecycle endpoints', async () => {
  const networkManager = createNetworkManager();
  const server = createBrokerServer({
    browserManager: {
      activeInstance: () => undefined,
      listInstances: () => [],
    },
    networkManager,
  });

  const { port, close } = await listen(server);
  try {
    const create = await requestJson({
      port,
      method: 'POST',
      path: '/_broker/networks',
      body: {
        id: 'shared-whistle',
        kind: 'whistle',
        proxy: { mode: 'direct', server: 'http://proxy.internal:8899' },
        browser: { ignoreSslErrors: true, proxyBypassList: '<-loopback>' },
      },
    });
    const list = await requestJson({
      port,
      method: 'GET',
      path: '/_broker/networks',
    });
    const check = await requestJson({
      port,
      method: 'POST',
      path: '/_broker/networks/shared-whistle/check',
    });
    const deleted = await requestJson({
      port,
      method: 'DELETE',
      path: '/_broker/networks/shared-whistle',
    });

    assert.equal(create.statusCode, 200);
    assert.equal(create.body.network.id, 'shared-whistle');
    assert.deepEqual(create.body.network.resolved, {
      proxyServer: 'http://proxy.internal:8899',
      ignoreSslErrors: true,
      proxyBypassList: '<-loopback>',
    });
    assert.equal(list.body.networks[0].id, 'shared-whistle');
    assert.equal(check.body.reachable, true);
    assert.equal(check.body.resolved.proxyServer, 'http://proxy.internal:8899');
    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.body.networkId, 'shared-whistle');
  } finally {
    await close();
  }
});

test('start control route resolves networkId to launch options', async () => {
  const starts = [];
  const networkManager = createNetworkManager();
  await networkManager.upsert({
    id: 'shared-whistle',
    proxy: { mode: 'direct', server: 'http://proxy.internal:8899' },
    browser: { ignoreSslErrors: true, proxyBypassList: '<-loopback>' },
  });
  const server = createBrokerServer({
    browserManager: {
      activeInstance: () => undefined,
      listInstances: () => [],
      start: async (options) => {
        starts.push(options);
        return {
          id: 'bkr_abc',
          profile: 'work-okta',
          networkId: options.networkId,
          proxyServer: options.proxyServer,
          chromeHost: '127.0.0.1',
          chromePort: 9333,
          pid: 123,
          startedAt: '2026-06-16T00:00:00.000Z',
        };
      },
    },
    networkManager,
  });

  const { port, close } = await listen(server);
  try {
    const response = await requestJson({
      port,
      method: 'POST',
      path: '/_broker/start',
      body: {
        profile: 'work-okta',
        networkId: 'shared-whistle',
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(starts, [
      {
        profile: 'work-okta',
        networkId: 'shared-whistle',
        proxyServer: 'http://proxy.internal:8899',
        proxyBypassList: '<-loopback>',
        ignoreSslErrors: true,
      },
    ]);
    assert.equal(response.body.networkId, 'shared-whistle');
    assert.equal(response.body.proxyServer, 'http://proxy.internal:8899');
  } finally {
    await close();
  }
});

test('serves persistent profile clear endpoint', async () => {
  const clears = [];
  const server = createBrokerServer({
    browserManager: {
      activeInstance: () => undefined,
      listInstances: () => [],
      clearProfileData: (options) => {
        clears.push(options);
        return {
          cleared: true,
          profile: options.profile,
          userDataDir: `/home/test/.pw-cdp-broker/profiles/${options.profile}`,
        };
      },
    },
  });

  const { port, close } = await listen(server);
  try {
    const response = await requestJson({
      port,
      method: 'POST',
      path: '/_broker/profiles/clear',
      body: { profile: 'work-okta' },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(clears, [{ profile: 'work-okta' }]);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.cleared, true);
    assert.equal(response.body.profile, 'work-okta');
  } finally {
    await close();
  }
});

test('serves a copyable Playwright broker client helper', async () => {
  const server = createBrokerServer({
    browserManager: {
      activeInstance: () => undefined,
      listInstances: () => [],
    },
  });

  const { port, close } = await listen(server);
  try {
    const response = await requestText({
      port,
      method: 'GET',
      path: '/_broker/client.js',
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /text\/javascript/);
    assert.match(response.body, new RegExp(`brokerUrl = 'http://127\\.0\\.0\\.1:${port}'`));
    assert.match(response.body, /export async function connectViaBroker/);
    assert.match(response.body, /chromium\.connectOverCDP\(instance\.cdpUrl\)/);
    assert.match(response.body, /networkId/);
    assert.match(response.body, /proxyForwardId/);
  } finally {
    await close();
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      resolve({
        port: address.port,
        close: () => new Promise((closeResolve) => server.close(closeResolve)),
      });
    });
  });
}

function requestText({ port, method, path }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body,
          });
        });
      }
    );
    request.once('error', reject);
    request.end();
  });
}

function requestJson({ port, method, path, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: payload
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            }
          : undefined,
      },
      (response) => {
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
      }
    );
    request.once('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}
