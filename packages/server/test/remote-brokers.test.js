import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

import {
  buildSshLocalForwardCancelArgs,
  buildSshLocalForwardArgs,
  buildSshRemoteBrokerBootstrapArgs,
  buildSshRemoteBrokerStopArgs,
  createRemoteBrokerManager,
} from '../src/remote-brokers.js';

function fakeChild({ exitOnSignal = 'SIGTERM' } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.signals = [];
  child.kill = (signal = 'SIGTERM') => {
    child.signals.push(signal);
    if (signal !== exitOnSignal || child.exitCode !== null) return true;
    child.killed = true;
    child.signalCode = signal;
    queueMicrotask(() => {
      child.emit('exit', null, signal);
      child.emit('close', null, signal);
    });
    return true;
  };
  return child;
}

function linuxCommandResult(args) {
  if (args.includes('uname')) return { status: 0, stdout: 'Linux\n', stderr: '' };
  return { status: 0, stdout: '', stderr: '' };
}

function createLinuxHarness(overrides = {}) {
  const commands = [];
  const forwards = [];
  const manager = createRemoteBrokerManager({
    async runCommandImpl(command, args, options) {
      commands.push({ command, args, options });
      return linuxCommandResult(args);
    },
    spawnImpl(command, args, options) {
      const child = fakeChild(overrides.forwardChildOptions);
      forwards.push({ command, args, options, child });
      return child;
    },
    probe: async () => {},
    findLocalPort: async () => 18083,
    isLocalPortAvailable: async () => true,
    localRevision: 'abc123',
    forwardStopGraceMs: 5,
    localPortReleaseTimeoutMs: 20,
    ...overrides,
  });
  return { manager, commands, forwards };
}

function decodeWindowsPowerShell(args) {
  const launcher = String(args.at(-1)).split(' -Command ')[1];
  const compressed = launcher.match(/FromBase64String\('([^']+)'\)/)[1];
  return gunzipSync(Buffer.from(compressed, 'base64')).toString('utf16le');
}

test('builds remote commands and an isolated loopback-only SSH forward', () => {
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
      identityFile: '/tmp/id_ed25519',
    }),
    [
      '-N',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=2',
      '-i', '/tmp/id_ed25519', '-o', 'IdentitiesOnly=yes',
      '-L', '127.0.0.1:18083:127.0.0.1:18080',
      '--', 'agent@linux-box',
    ]
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

test('provisions, lists, and releases one owned SSH forward child', async () => {
  const { manager, commands, forwards } = createLinuxHarness({
    now: () => '2026-08-09T00:00:00.000Z',
  });

  const record = await manager.provision({ id: 'staging', target: 'agent@linux-box' });
  assert.deepEqual(record, {
    id: 'staging',
    target: 'agent@linux-box',
    repository: 'https://github.com/sloppygadget-bot/pw-dev.git',
    worktree: '.pw-dev/pw-dev',
    revision: 'abc123',
    remotePort: 18080,
    platform: 'linux',
    localPort: 18083,
    connectionDirection: 'outward',
    brokerUrl: 'http://127.0.0.1:18083',
    createdAt: '2026-08-09T00:00:00.000Z',
    status: 'ready',
    reconnectAttempts: 0,
  });
  assert.equal(commands.length, 3);
  assert.equal(forwards.length, 1);
  assert.ok(forwards[0].args.includes('ExitOnForwardFailure=yes'));
  assert.deepEqual(manager.list(), [record]);

  assert.equal(await manager.remove('staging'), true);
  assert.deepEqual(forwards[0].child.signals, ['SIGTERM']);
  assert.deepEqual(manager.list(), []);
});

test('retries with the same local URL after a health failure without overlapping forwards', async () => {
  let reachable = true;
  const { manager, forwards } = createLinuxHarness({
    probe: async () => {
      if (!reachable) throw new Error('unreachable');
    },
    reconnectInitialDelayMs: 0,
    reconnectMaxDelayMs: 0,
    healthCheckIntervalMs: 1,
  });

  const original = await manager.provision({ id: 'liveness', target: 'agent@linux-box' });
  reachable = false;
  setTimeout(() => { reachable = true; }, 8);
  await new Promise((resolve) => setTimeout(resolve, 160));

  assert.ok(forwards.length >= 2);
  assert.deepEqual(forwards[0].child.signals, ['SIGTERM']);
  assert.equal(manager.list()[0].brokerUrl, original.brokerUrl);
  assert.equal(manager.list()[0].status, 'ready');
  assert.equal(manager.list()[0].reconnectAttempts, 0);
  await manager.remove('liveness');
});

test('a hung SSH forward is force-killed asynchronously and does not block timers', async () => {
  let reachable = true;
  let timerFired = false;
  const { manager, forwards } = createLinuxHarness({
    forwardChildOptions: { exitOnSignal: 'SIGKILL' },
    probe: async () => {
      if (!reachable) throw new Error('transport stalled');
    },
    reconnectInitialDelayMs: 0,
    reconnectMaxDelayMs: 0,
    healthCheckIntervalMs: 1,
    forwardStopGraceMs: 10,
  });

  await manager.provision({ id: 'hung-forward', target: 'agent@linux-box' });
  reachable = false;
  setTimeout(() => { timerFired = true; }, 3);
  setTimeout(() => { reachable = true; }, 18);
  await new Promise((resolve) => setTimeout(resolve, 160));

  assert.equal(timerFired, true);
  assert.deepEqual(forwards[0].child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(manager.list()[0].status, 'ready');
  await manager.remove('hung-forward');
});

test('manager close aborts an in-flight SSH bootstrap without blocking shutdown', async () => {
  let bootstrapStarted;
  const started = new Promise((resolve) => { bootstrapStarted = resolve; });
  const forwards = [];
  const manager = createRemoteBrokerManager({
    async runCommandImpl(command, args, options) {
      if (args.includes('uname')) return { status: 0, stdout: 'Linux\n', stderr: '' };
      if (!options?.input) return { status: 0, stdout: '', stderr: '' };
      bootstrapStarted();
      return new Promise((resolve) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.code = 'ABORT_ERR';
          resolve({ status: null, stdout: '', stderr: '', error });
        }, { once: true });
      });
    },
    spawnImpl() {
      const child = fakeChild();
      forwards.push(child);
      return child;
    },
    probe: async () => {},
    findLocalPort: async () => 18088,
    isLocalPortAvailable: async () => true,
    localRevision: 'abc123',
    forwardStopGraceMs: 5,
  });

  const provisioning = manager.provision({ id: 'closing', target: 'agent@linux-box' }).catch((error) => error);
  await started;
  const startedAt = Date.now();
  await manager.close();
  assert.ok(Date.now() - startedAt < 100, 'manager close should abort rather than await the SSH timeout');
  const error = await provisioning;
  assert.equal(error.statusCode, 502);
  assert.equal(forwards[0].signals.includes('SIGTERM'), true);
  assert.deepEqual(manager.list(), []);
});

test('waits for local port ownership to clear before starting a replacement', async () => {
  let reachable = true;
  let portAvailable = true;
  let checks = 0;
  const { manager, forwards } = createLinuxHarness({
    probe: async () => {
      if (!reachable) throw new Error('unreachable');
    },
    isLocalPortAvailable: async () => {
      checks += 1;
      return portAvailable;
    },
    reconnectInitialDelayMs: 0,
    reconnectMaxDelayMs: 0,
    healthCheckIntervalMs: 1,
    localPortReleaseTimeoutMs: 5,
  });

  await manager.provision({ id: 'port-owner', target: 'agent@linux-box' });
  reachable = false;
  portAvailable = false;
  setTimeout(() => { portAvailable = true; reachable = true; }, 15);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(checks > 2);
  assert.ok(forwards.length >= 2);
  assert.equal(manager.list()[0].status, 'ready');
  await manager.remove('port-owner');
});

test('stops a pw-dev-managed remote broker after releasing its local forward', async () => {
  const { manager, commands, forwards } = createLinuxHarness();

  await manager.provision({ id: 'stop-me', target: 'agent@linux-box' });
  assert.equal(await manager.stop('stop-me'), true);
  assert.deepEqual(forwards[0].child.signals, ['SIGTERM']);
  const stop = commands.find(({ options }) => String(options?.input || '').includes("printf 'stopped=true"));
  assert.ok(stop);
  assert.deepEqual(manager.list(), []);
});

test('Linux bootstrap stops an unhealthy managed PID before replacing it and commits PID only after readiness', async () => {
  const { manager, commands } = createLinuxHarness();
  await manager.provision({ id: 'pid-ownership', target: 'agent@linux-box' });
  const bootstrap = commands.find(({ options }) => String(options?.input || '').includes('stop_managed_broker()'));
  assert.ok(bootstrap);
  assert.match(bootstrap.options.input, /if \[ -s "\$pid_file" \]; then\s+stop_managed_broker/);
  assert.match(bootstrap.options.input, /pending_pid_file=/);
  assert.match(bootstrap.options.input, /mv "\$pending_pid_file" "\$pid_file"/);
  await manager.remove('pid-ownership');
});

test('auto-detects Windows, preserves identity options, and owns a PID-tracked foreground broker', async () => {
  const commands = [];
  const children = [];
  const manager = createRemoteBrokerManager({
    async runCommandImpl(command, args, options) {
      commands.push({ command, args, options });
      if (args.includes('uname')) return { status: 1, stdout: '', stderr: "'uname' is not recognized" };
      if (args.includes('ver')) return { status: 0, stdout: 'Microsoft Windows [Version 10.0.22631.1]\r\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
    spawnImpl(command, args, options) {
      const child = fakeChild();
      children.push({ command, args, options, child });
      return child;
    },
    probe: async () => {},
    findLocalPort: async () => 18087,
    isLocalPortAvailable: async () => true,
    localRevision: 'abc123',
    forwardStopGraceMs: 5,
  });

  const record = await manager.provision({
    id: 'windows-host',
    target: 'agent@windows-box',
    identityFile: '/tmp/windows-key',
  });
  assert.equal(record.platform, 'windows');
  const bootstrap = children.find(({ args }) => String(args.at(-1)).startsWith('powershell.exe ') && decodeWindowsPowerShell(args).includes('Start-Process'));
  assert.ok(bootstrap);
  assert.ok(bootstrap.args.includes('/tmp/windows-key'));
  assert.ok(bootstrap.args.at(-1).length < 8_191);
  const script = decodeWindowsPowerShell(bootstrap.args);
  assert.match(script, /Start-Process/);
  assert.match(script, /pendingPidFile/);
  assert.match(script, /Stop-ManagedBroker/);
  assert.match(script, /Wait-Process -Id \$managedPid/);
  assert.doesNotMatch(script, /Get-Command git/);
  const sourceCopy = commands.find(({ command }) => command === 'scp');
  assert.ok(sourceCopy);
  assert.ok(sourceCopy.args.includes('/tmp/windows-key'));
  assert.ok(sourceCopy.args.some((arg) => String(arg).endsWith('/packages/cdp-broker')));

  await manager.stop('windows-host');
  assert.equal(children.length, 2);
  assert.ok(children.every(({ child }) => child.signals.includes('SIGTERM')));
  const stop = commands.find(({ args }) => String(args.at(-1)).startsWith('powershell.exe ') && decodeWindowsPowerShell(args).includes("Write-Output 'stopped=true'"));
  assert.ok(stop);
});
