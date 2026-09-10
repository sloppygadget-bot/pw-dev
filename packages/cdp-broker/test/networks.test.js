import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createNetworkManager } from '../src/networks.js';
import { createProxyForwardManager } from '../src/proxy-forwards.js';

test('creates ssh-peer networks through proxy forwards', async () => {
  const creates = [];
  const deletes = [];
  const manager = createNetworkManager({
    proxyForwardManager: {
      create: async (options) => {
        creates.push(options);
        return {
          forwardId: 'pf_abc',
          proxyServer: 'http://127.0.0.1:18899',
        };
      },
      delete: (forwardId, instances) => {
        deletes.push({ forwardId, instances });
        return { deleted: true, forwardId };
      },
    },
  });

  const network = await manager.upsert({
    id: 'agent-whistle',
    proxy: { mode: 'ssh-peer', remotePort: 8899, localPort: 18899 },
    browser: { ignoreSslErrors: true },
  });

  assert.deepEqual(creates, [
    { name: 'agent-whistle', remotePort: 8899, localPort: 18899 },
  ]);
  assert.equal(network.resolved.proxyForwardId, 'pf_abc');
  assert.equal(network.resolved.proxyServer, 'http://127.0.0.1:18899');
  assert.deepEqual(manager.resolve('agent-whistle'), {
    networkId: 'agent-whistle',
    proxyForwardId: 'pf_abc',
    proxyServer: 'http://127.0.0.1:18899',
    ignoreSslErrors: true,
  });

  const deleted = manager.delete('agent-whistle');

  assert.deepEqual(deleted, { deleted: true, networkId: 'agent-whistle' });
  assert.deepEqual(deletes, [{ forwardId: 'pf_abc', instances: [] }]);
});

test('rejects changing an in-use network', async () => {
  const manager = createNetworkManager();
  await manager.upsert({
    id: 'shared-whistle',
    proxy: { mode: 'direct', server: 'http://proxy.internal:8899' },
  });

  await assert.rejects(
    () => manager.upsert(
      {
        id: 'shared-whistle',
        proxy: { mode: 'direct', server: 'http://proxy.internal:9999' },
      },
      [{ id: 'bkr_1', networkId: 'shared-whistle' }]
    ),
    /Network is in use/
  );
});

test('reports active ssh-peer probe results', async () => {
  const manager = createNetworkManager({
    proxyForwardManager: {
      create: async () => ({
        forwardId: 'pf_probe',
        proxyServer: 'http://127.0.0.1:18899',
      }),
      check: async (forwardId, options) => ({
        forwardId,
        reachable: true,
        statusCode: 407,
        target: `${options.host}:${options.port}`,
      }),
    },
  });
  await manager.upsert({
    id: 'probe-network',
    proxy: { mode: 'ssh-peer', remotePort: 8899 },
  });

  const result = await manager.check('probe-network', [], {
    host: 'proxy-check.invalid',
    port: 80,
  });

  assert.equal(result.reachable, true);
  assert.deepEqual(result.probe, {
    forwardId: 'pf_probe',
    reachable: true,
    statusCode: 407,
    target: 'proxy-check.invalid:80',
  });
});

test('ssh-peer networks keep stable resolved forwards across tunnel recovery', async () => {
  const children = [];
  const proxyForwardManager = createProxyForwardManager({
    sshTarget: 'user@code-server',
    controlPath: '/tmp/control-%C',
    spawnImpl: () => {
      const child = new EventEmitter();
      child.killed = false;
      child.kill = (signal) => {
        child.killed = true;
        child.emit('exit', null, signal);
      };
      children.push(child);
      return child;
    },
    quiet: true,
  });
  const manager = createNetworkManager({ proxyForwardManager });
  await manager.upsert({
    id: 'recovering-network',
    proxy: { mode: 'ssh-peer', remotePort: 8899, localPort: 18899 },
  });
  const before = manager.resolve('recovering-network');

  proxyForwardManager.disconnectAll();
  proxyForwardManager.restoreAll();
  const after = manager.resolve('recovering-network');

  assert.deepEqual(after, before);
  assert.equal(proxyForwardManager.get(before.proxyForwardId).forwardId, before.proxyForwardId);
  assert.equal(children.length, 2);
});
