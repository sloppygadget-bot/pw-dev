import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import {
  buildProxySshArgs,
  createProxyForwardManager,
} from '../src/proxy-forwards.js';

function fakeChild() {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    child.signal = signal;
    child.emit('exit', null, signal);
  };
  return child;
}

test('builds SSH args for a proxy forward', () => {
  assert.deepEqual(
    buildProxySshArgs({
      target: 'user@code-server',
      localPort: 18899,
      remotePort: 8899,
      controlPersist: '24h',
      controlPath: '/tmp/control-%C',
    }),
    [
      '-o',
      'ControlMaster=auto',
      '-o',
      'ControlPersist=24h',
      '-o',
      'ControlPath=/tmp/control-%C',
      '-o',
      'ExitOnForwardFailure=yes',
      '-N',
      '-L',
      '18899:localhost:8899',
      'user@code-server',
    ]
  );
});

test('creates and lists proxy forwards', async () => {
  const child = fakeChild();
  const spawned = [];
  const manager = createProxyForwardManager({
    sshTarget: 'user@code-server',
    controlPersist: '24h',
    controlPath: '/tmp/control-%C',
    spawnImpl: (file, args, options) => {
      spawned.push({ file, args, options });
      return child;
    },
    quiet: true,
  });

  const forward = await manager.create({
    name: 'whistle',
    remotePort: 8899,
    localPort: 18899,
  });

  assert.match(forward.forwardId, /^pf_/);
  assert.equal(forward.proxyServer, 'http://127.0.0.1:18899');
  assert.equal(spawned[0].file, 'ssh');
  assert.ok(spawned[0].args.includes('18899:localhost:8899'));
  assert.deepEqual(manager.list(), [forward]);
});

test('allocates local port when omitted', async () => {
  const manager = createProxyForwardManager({
    sshTarget: 'user@code-server',
    controlPersist: '24h',
    controlPath: '/tmp/control-%C',
    spawnImpl: () => fakeChild(),
    getFreePortImpl: async () => 19000,
    quiet: true,
  });

  const forward = await manager.create({ remotePort: 8899 });

  assert.equal(forward.localPort, 19000);
  assert.equal(forward.proxyServer, 'http://127.0.0.1:19000');
});

test('rejects create without SSH target', async () => {
  const manager = createProxyForwardManager({ quiet: true });

  await assert.rejects(() => manager.create({ remotePort: 8899 }), /require broker --ssh/);
});

test('rejects duplicate proxy forward ports', async () => {
  const manager = createProxyForwardManager({
    sshTarget: 'user@code-server',
    controlPersist: '24h',
    controlPath: '/tmp/control-%C',
    spawnImpl: () => fakeChild(),
    quiet: true,
  });

  await manager.create({ remotePort: 8899, localPort: 18899 });

  await assert.rejects(
    () => manager.create({ remotePort: 8899, localPort: 18900 }),
    /remotePort/
  );
  await assert.rejects(
    () => manager.create({ remotePort: 8898, localPort: 18899 }),
    /localPort/
  );
});

test('rejects deleting an in-use proxy forward', async () => {
  const manager = createProxyForwardManager({
    sshTarget: 'user@code-server',
    controlPersist: '24h',
    controlPath: '/tmp/control-%C',
    spawnImpl: () => fakeChild(),
    quiet: true,
  });

  const forward = await manager.create({ remotePort: 8899, localPort: 18899 });

  assert.throws(
    () => manager.delete(forward.forwardId, [{ id: 'bkr_1', proxyForwardId: forward.forwardId }]),
    /in use/
  );
});

test('deletes unused proxy forward', async () => {
  const child = fakeChild();
  const manager = createProxyForwardManager({
    sshTarget: 'user@code-server',
    controlPersist: '24h',
    controlPath: '/tmp/control-%C',
    spawnImpl: () => child,
    quiet: true,
  });

  const forward = await manager.create({ remotePort: 8899, localPort: 18899 });
  const result = manager.delete(forward.forwardId);

  assert.deepEqual(result, { deleted: true, forwardId: forward.forwardId });
  assert.equal(child.killed, true);
  assert.deepEqual(manager.list(), []);
});

test('probes the forwarded HTTP proxy', async () => {
  const probeServer = http.createServer();
  probeServer.on('connect', (req, socket) => {
    socket.end('HTTP/1.1 200 Connection Established\r\nConnection: close\r\n\r\n');
  });
  await new Promise((resolve) => probeServer.listen(0, '127.0.0.1', resolve));
  const port = probeServer.address().port;
  const child = fakeChild();
  const manager = createProxyForwardManager({
    sshTarget: 'user@code-server',
    spawnImpl: () => child,
    quiet: true,
  });

  try {
    const forward = await manager.create({ remotePort: 8899, localPort: port });
    const result = await manager.check(forward.forwardId, {
      host: 'example.com',
      port: 80,
      timeoutMs: 1000,
    });

    assert.equal(result.reachable, true);
    assert.equal(result.statusCode, 200);
    assert.equal(result.remotePort, 8899);
  } finally {
    await new Promise((resolve) => probeServer.close(resolve));
  }
});
