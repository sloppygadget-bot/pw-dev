import assert from 'node:assert/strict';
import test from 'node:test';

import { createNetworkManager } from '../src/networks.js';

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
