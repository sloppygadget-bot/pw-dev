import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSshLocalForwardCancelArgs,
  buildSshLocalForwardArgs,
  buildSshRemoteBrokerBootstrapArgs,
  buildSshRemoteBrokerStopArgs,
  createRemoteBrokerManager,
} from '../src/remote-brokers.js';

test('builds remote bootstrap and loopback-only local forward arguments', () => {
  assert.deepEqual(
    buildSshRemoteBrokerBootstrapArgs({
      target: 'agent@linux-box',
      repository: 'https://example.test/pw-dev.git',
      worktree: '.pw-dev/pw-dev',
      remotePort: 18080,
      revision: 'abc123',
    }),
    ['--', 'agent@linux-box', 'sh', '-s', '--', 'https://example.test/pw-dev.git', '.pw-dev/pw-dev', '18080', 'abc123']
  );
  assert.deepEqual(
    buildSshRemoteBrokerStopArgs({
      target: 'agent@linux-box',
      worktree: '.pw-dev/pw-dev',
      remotePort: 18080,
    }),
    ['--', 'agent@linux-box', 'sh', '-s', '--', '.pw-dev/pw-dev', '18080']
  );
  assert.deepEqual(
    buildSshLocalForwardArgs({
      target: 'agent@linux-box',
      localPort: 18083,
      remotePort: 18080,
    }),
    ['-O', 'forward', '-L', '127.0.0.1:18083:127.0.0.1:18080', '--', 'agent@linux-box']
  );
  assert.deepEqual(
    buildSshLocalForwardCancelArgs({
      target: 'agent@linux-box',
      localPort: 18083,
      remotePort: 18080,
    }),
    ['-O', 'cancel', '-L', '127.0.0.1:18083:127.0.0.1:18080', '--', 'agent@linux-box']
  );
});

test('provisions, lists, and releases one server-owned remote broker forward', async () => {
  const sshCalls = [];
  const manager = createRemoteBrokerManager({
    spawnSyncImpl(command, args, options) {
      sshCalls.push({ command, args, options });
      return { status: 0, stdout: '', stderr: '' };
    },
    probe: async () => {},
    findLocalPort: async () => 18083,
    now: () => '2026-08-09T00:00:00.000Z',
    localRevision: 'abc123',
    controlPath: '/tmp/pw-dev-test-%C',
  });

  const record = await manager.provision({ id: 'staging', target: 'agent@linux-box' });
  assert.deepEqual(record, {
    id: 'staging',
    target: 'agent@linux-box',
    repository: 'https://github.com/sloppygadget-bot/pw-dev.git',
    worktree: '.pw-dev/pw-dev',
    revision: 'abc123',
    remotePort: 18080,
    localPort: 18083,
    connectionDirection: 'outward',
    brokerUrl: 'http://127.0.0.1:18083',
    createdAt: '2026-08-09T00:00:00.000Z',
    status: 'ready',
    reconnectAttempts: 0,
  });
  assert.equal(sshCalls.length, 3);
  assert.deepEqual(manager.list(), [record]);

  assert.equal(await manager.remove('staging'), true);
  assert.equal(sshCalls.length, 4);
  assert.equal(sshCalls.at(-1).args[1], 'cancel');
  assert.deepEqual(manager.list(), []);
});

test('reconnects a control-managed forward after health failure', async () => {
  let reachable = true;
  const sshCalls = [];
  const manager = createRemoteBrokerManager({
    spawnSyncImpl(command, args) {
      sshCalls.push({ command, args });
      return { status: 0, stdout: '', stderr: '' };
    },
    probe: async () => {
      if (!reachable) throw new Error('unreachable');
    },
    findLocalPort: async () => 18084,
    reconnectInitialDelayMs: 0,
    reconnectMaxDelayMs: 0,
    healthCheckIntervalMs: 1,
    localRevision: 'abc123',
    controlPath: '/tmp/pw-dev-test-%C',
  });

  await manager.provision({ id: 'liveness', target: 'agent@linux-box' });
  reachable = false;
  setTimeout(() => { reachable = true; }, 2);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(sshCalls.some(({ args }) => args[1] === 'cancel'));
  assert.ok(sshCalls.filter(({ args }) => args[1] === 'forward').length >= 2);
  assert.equal(manager.list()[0].status, 'ready');
  assert.equal(manager.list()[0].reconnectAttempts, 0);
  await manager.remove('liveness');
});

test('stops a pw-dev-managed remote broker after releasing its local forward', async () => {
  const sshCalls = [];
  const manager = createRemoteBrokerManager({
    spawnSyncImpl(command, args, options) {
      sshCalls.push({ command, args, options });
      return { status: 0, stdout: '', stderr: '' };
    },
    probe: async () => {},
    findLocalPort: async () => 18086,
    localRevision: 'abc123',
    controlPath: '/tmp/pw-dev-test-%C',
  });

  await manager.provision({ id: 'stop-me', target: 'agent@linux-box' });
  assert.equal(await manager.stop('stop-me'), true);
  assert.equal(sshCalls.length, 5);
  assert.equal(sshCalls[3].args[1], 'cancel');
  assert.deepEqual(manager.list(), []);
});

test('replaces a zombie local forward when its broker health check fails', async () => {
  let reachable = true;
  const sshCalls = [];
  const manager = createRemoteBrokerManager({
    spawnSyncImpl(command, args) {
      sshCalls.push({ command, args });
      return { status: 0, stdout: '', stderr: '' };
    },
    probe: async () => {
      if (!reachable) throw new Error('unreachable');
    },
    findLocalPort: async () => 18085,
    reconnectInitialDelayMs: 0,
    reconnectMaxDelayMs: 0,
    healthCheckIntervalMs: 1,
    localRevision: 'abc123',
    controlPath: '/tmp/pw-dev-test-%C',
  });

  await manager.provision({ id: 'zombie', target: 'agent@linux-box' });
  reachable = false;
  setTimeout(() => { reachable = true; }, 2);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(sshCalls.some(({ args }) => args[1] === 'cancel'));
  assert.ok(sshCalls.filter(({ args }) => args[1] === 'forward').length >= 2);
  assert.equal(manager.list()[0].status, 'ready');
  await manager.remove('zombie');
});
