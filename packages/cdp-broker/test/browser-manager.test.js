import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBrowserManager } from '../src/browser-manager.js';

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

test('starts Chrome from remote lifecycle options', async () => {
  const child = fakeChild();
  const spawned = [];
  const waited = [];
  const manager = createBrowserManager({
    chromeExecutable: '/bin/chrome',
    spawnImpl: (file, args, options) => {
      spawned.push({ file, args, options });
      return child;
    },
    getFreePortImpl: async () => 9333,
    waitForChromeImpl: async (options) => {
      waited.push(options);
    },
    quiet: true,
  });

  const instance = await manager.start({
    profile: 'work-okta',
    proxyServer: 'http://127.0.0.1:18899',
    proxyBypassList: '<-loopback>',
    ignoreSslErrors: true,
  });

  assert.match(instance.id, /^bkr_/);
  assert.equal(instance.profile, 'work-okta');
  assert.equal(instance.chromeHost, '127.0.0.1');
  assert.equal(instance.chromePort, 9333);
  assert.equal(spawned[0].file, '/bin/chrome');
  assert.deepEqual(waited, [{ host: '127.0.0.1', port: 9333 }]);
  assert.ok(spawned[0].args.includes('--proxy-server=http://127.0.0.1:18899'));
  assert.ok(spawned[0].args.includes('--proxy-bypass-list=<-loopback>'));
  assert.ok(spawned[0].args.includes('--ignore-certificate-errors'));
  assert.ok(spawned[0].args.some((arg) => arg.startsWith('--user-data-dir=')));
});

test('requires a profile when no default profile or user data dir is configured', async () => {
  const manager = createBrowserManager({
    chromeExecutable: '/bin/chrome',
    spawnImpl: () => fakeChild(),
    getFreePortImpl: async () => 9333,
    waitForChromeImpl: async () => {},
    quiet: true,
  });

  await assert.rejects(() => manager.start({}), /profile is required/);
});

test('stops the active Chrome instance', async () => {
  const child = fakeChild();
  const manager = createBrowserManager({
    chromeExecutable: '/bin/chrome',
    spawnImpl: () => child,
    getFreePortImpl: async () => 9333,
    waitForChromeImpl: async () => {},
    quiet: true,
  });

  const instance = await manager.start({ profile: 'work-okta' });
  const result = await manager.stop({ instanceId: instance.id });

  assert.deepEqual(result, { stopped: true, instanceId: instance.id });
  assert.equal(child.killed, true);
  assert.equal(manager.activeInstance(), undefined);
});

test('starts multiple Chrome instances with different profiles', async () => {
  const children = [fakeChild(), fakeChild()];
  const spawned = [];
  const ports = [9333, 9334];
  const manager = createBrowserManager({
    chromeExecutable: '/bin/chrome',
    spawnImpl: (file, args) => {
      spawned.push({ file, args });
      return children.shift();
    },
    getFreePortImpl: async () => ports.shift(),
    waitForChromeImpl: async () => {},
    quiet: true,
  });

  const first = await manager.start({ profile: 'work-okta' });
  const second = await manager.start({ profile: 'customer-a', headless: true });

  assert.notEqual(first.id, second.id);
  assert.equal(manager.listInstances().length, 2);
  assert.equal(first.chromePort, 9333);
  assert.equal(second.chromePort, 9334);
  assert.ok(spawned[1].args.includes('--headless=new'));
  assert.throws(() => manager.activeInstance(), /Multiple Chrome instances/);
});

test('rejects concurrent instances using the same profile directory', async () => {
  const manager = createBrowserManager({
    chromeExecutable: '/bin/chrome',
    spawnImpl: () => fakeChild(),
    getFreePortImpl: async () => 9333,
    waitForChromeImpl: async () => {},
    quiet: true,
  });

  await manager.start({ profile: 'work-okta' });
  await assert.rejects(() => manager.start({ profile: 'work-okta' }), /already in use/);
});

test('stops one Chrome instance without affecting another', async () => {
  const firstChild = fakeChild();
  const secondChild = fakeChild();
  const children = [firstChild, secondChild];
  const ports = [9333, 9334];
  const manager = createBrowserManager({
    chromeExecutable: '/bin/chrome',
    spawnImpl: () => children.shift(),
    getFreePortImpl: async () => ports.shift(),
    waitForChromeImpl: async () => {},
    quiet: true,
  });

  const first = await manager.start({ profile: 'work-okta' });
  const second = await manager.start({ profile: 'customer-a' });

  await manager.stop({ instanceId: first.id });

  assert.equal(firstChild.killed, true);
  assert.equal(secondChild.killed, false);
  assert.deepEqual(manager.listInstances().map((instance) => instance.id), [second.id]);
});

test('requires instanceId when stopping among multiple Chrome instances', async () => {
  const ports = [9333, 9334];
  const manager = createBrowserManager({
    chromeExecutable: '/bin/chrome',
    spawnImpl: () => fakeChild(),
    getFreePortImpl: async () => ports.shift(),
    waitForChromeImpl: async () => {},
    quiet: true,
  });

  await manager.start({ profile: 'work-okta' });
  await manager.start({ profile: 'customer-a' });

  await assert.rejects(() => manager.stop(), /instanceId is required/);
});

test('stops all Chrome instances', async () => {
  const children = [fakeChild(), fakeChild()];
  const ports = [9333, 9334];
  const manager = createBrowserManager({
    chromeExecutable: '/bin/chrome',
    spawnImpl: () => children.shift(),
    getFreePortImpl: async () => ports.shift(),
    waitForChromeImpl: async () => {},
    quiet: true,
  });

  await manager.start({ profile: 'work-okta' });
  await manager.start({ profile: 'customer-a' });

  assert.equal(await manager.stopAll(), 2);
  assert.deepEqual(manager.listInstances(), []);
});

test('clears broker-managed persistent profile data', () => {
  const previousHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-cdp-broker-home-'));
  process.env.HOME = home;
  try {
    const profileDir = path.join(home, '.pw-cdp-broker', 'profiles', 'work-okta');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'cookie-store'), 'secret');
    const manager = createBrowserManager({
      chromeExecutable: '/bin/chrome',
      spawnImpl: () => fakeChild(),
      waitForChromeImpl: async () => {},
      quiet: true,
    });

    const result = manager.clearProfileData({ profile: 'work-okta' });

    assert.equal(result.cleared, true);
    assert.equal(result.profile, 'work-okta');
    assert.equal(fs.existsSync(profileDir), false);
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('rejects clearing a profile used by an active Chrome instance', async () => {
  const manager = createBrowserManager({
    chromeExecutable: '/bin/chrome',
    spawnImpl: () => fakeChild(),
    getFreePortImpl: async () => 9333,
    waitForChromeImpl: async () => {},
    quiet: true,
  });

  await manager.start({ profile: 'work-okta' });

  assert.throws(() => manager.clearProfileData({ profile: 'work-okta' }), /currently in use/);
});
