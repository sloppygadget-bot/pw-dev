import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createDisplayManager } from '../src/display.js';

function fakeXvfb() {
  const child = new EventEmitter();
  child.pid = 1234;
  child.exitCode = null;
  child.signalCode = null;
  child.stderr = new PassThrough();
  child.stdio = [null, null, child.stderr, new PassThrough()];
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    child.signalCode = signal;
    child.emit('exit', null, signal);
  };
  return child;
}

test('headless and non-Linux launches need no display utilities', async () => {
  for (const options of [{ platform: 'linux', headless: true }, { platform: 'darwin' }, { platform: 'win32' }]) {
    const manager = createDisplayManager({
      env: {},
      platform: options.platform,
      listDisplaysImpl: () => assert.fail('display discovery should be skipped'),
      spawnImpl: () => assert.fail('Xvfb should not be started'),
    });
    const lease = await manager.acquire({ headless: options.headless });
    assert.equal(lease.display, undefined);
    await lease.release();
  }
});

test('honors explicit and inherited displays without taking ownership', async () => {
  const manager = createDisplayManager({
    env: { DISPLAY: ':7' }, platform: 'linux',
    spawnImpl: () => assert.fail('must not start Xvfb'),
  });
  for (const [options, display] of [[{}, ':7'], [{ display: ':1' }, ':1']]) {
    const lease = await manager.acquire(options);
    assert.equal(lease.display, display);
    await lease.release();
  }
});

test('reuses an accessible local display and leaves it running', async () => {
  const probed = [];
  const manager = createDisplayManager({
    env: {}, platform: 'linux',
    listDisplaysImpl: () => [':0', ':1'],
    probeDisplayImpl: async (display) => { probed.push(display); return display === ':1'; },
    spawnImpl: () => assert.fail('must reuse the existing display'),
  });
  const lease = await manager.acquire();
  assert.equal(lease.display, ':1');
  assert.deepEqual(probed, [':0', ':1']);
  await lease.release();
});

test('concurrent headed launches share Xvfb until the last lease is released', async () => {
  const child = fakeXvfb();
  const calls = [];
  const manager = createDisplayManager({
    env: {}, platform: 'linux', listDisplaysImpl: () => [],
    spawnImpl: (file, args, options) => {
      calls.push({ file, args, options });
      setImmediate(() => child.stdio[3].write('42\n'));
      return child;
    },
  });
  const [first, second] = await Promise.all([manager.acquire(), manager.acquire()]);
  assert.equal(first.display, ':42');
  assert.equal(second.display, ':42');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'Xvfb');
  assert.deepEqual(calls[0].args, ['-displayfd', '3', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp']);
  await first.release();
  await first.release();
  assert.deepEqual(child.signals, []);
  await second.release();
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('missing Xvfb produces an actionable launch error', async () => {
  const child = fakeXvfb();
  child.pid = undefined;
  const manager = createDisplayManager({
    env: {}, platform: 'linux', listDisplaysImpl: () => [],
    spawnImpl: () => {
      queueMicrotask(() => child.emit('error', new Error('spawn Xvfb ENOENT')));
      return child;
    },
  });
  await assert.rejects(manager.acquire(), /Install Xvfb or set DISPLAY/);
});

test('failed and timed out Xvfb startups release their child process', async () => {
  for (const earlyExit of [false, true]) {
    const child = fakeXvfb();
    const manager = createDisplayManager({
      env: {}, platform: 'linux', listDisplaysImpl: () => [], timeoutMs: 20,
      spawnImpl: () => {
        if (earlyExit) queueMicrotask(() => {
          child.stderr.write('X server failed');
          child.exitCode = 1;
          child.emit('exit', 1, null);
        });
        return child;
      },
    });
    await assert.rejects(manager.acquire(), earlyExit ? /X server failed/ : /within 20ms/);
    assert.deepEqual(child.signals, earlyExit ? [] : ['SIGTERM']);
  }
});
