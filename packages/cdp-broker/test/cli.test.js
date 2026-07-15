import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSshArgs,
  buildSshControlCheckArgs,
  buildSshControlMasterArgs,
  buildSshConfigArgs,
  buildSshRemoteMachineArgs,
  parseSshRemoteMachine,
  parseSshConfigValue,
  parseArgs,
  resolveSshControlPath,
} from '../src/cli.js';

test('parses proxy and SSL options', () => {
  assert.deepEqual(
    parseArgs([
      '--proxy-server',
      'http://127.0.0.1:8899',
      '--proxy-bypass-list=<-loopback>',
      '--ignore-ssl-errors',
    ]),
    {
      chromeArg: [],
      proxyServer: 'http://127.0.0.1:8899',
      proxyBypassList: '<-loopback>',
      ignoreSslErrors: true,
    }
  );
});

test('parses SSH proxy forwarding options', () => {
  assert.deepEqual(
    parseArgs([
      '--ssh',
      'user@code-server',
      '--ssh-proxy-remote-port',
      '8899',
      '--ssh-proxy-local-port=18899',
    ]),
    {
      chromeArg: [],
      ssh: 'user@code-server',
      sshProxyRemotePort: '8899',
      sshProxyLocalPort: '18899',
    }
  );
});

test('parses quiet option', () => {
  assert.deepEqual(parseArgs(['--quiet']), {
    chromeArg: [],
    quiet: true,
  });
});

test('parses standby option', () => {
  assert.deepEqual(parseArgs(['--standby']), {
    chromeArg: [],
    standby: true,
  });
});

test('builds SSH control forward args with reverse broker tunnel and local proxy forward', () => {
  assert.deepEqual(
    buildSshArgs({
      target: 'user@code-server',
      localPort: 18080,
      remotePort: 18080,
      controlPath: '/tmp/control-%C',
      proxyForward: {
        localPort: 18899,
        remotePort: 8899,
      },
    }),
    [
      '-o',
      'ControlPath=/tmp/control-%C',
      '-o',
      'ExitOnForwardFailure=yes',
      '-O',
      'forward',
      '-L',
      '18899:localhost:8899',
      '-R',
      '18080:localhost:18080',
      'user@code-server',
    ]
  );
});

test('builds SSH control cancel args', () => {
  assert.deepEqual(
    buildSshArgs({
      target: 'user@code-server',
      localPort: 18080,
      remotePort: 18080,
      controlPath: '/tmp/control-%C',
      controlCommand: 'cancel',
    }),
    [
      '-o',
      'ControlPath=/tmp/control-%C',
      '-o',
      'ExitOnForwardFailure=yes',
      '-O',
      'cancel',
      '-R',
      '18080:localhost:18080',
      'user@code-server',
    ]
  );
});

test('builds SSH control master check args', () => {
  assert.deepEqual(
    buildSshControlCheckArgs({
      target: 'user@code-server',
      controlPath: '/tmp/control-%C',
    }),
    ['-o', 'ControlPath=/tmp/control-%C', '-O', 'check', 'user@code-server']
  );
});

test('builds detached SSH control master args', () => {
  assert.deepEqual(
    buildSshControlMasterArgs({
      target: 'user@code-server',
      controlPersist: '12h',
      controlPath: '/tmp/control-%C',
    }),
    [
      '-o',
      'ControlMaster=yes',
      '-o',
      'ControlPersist=12h',
      '-o',
      'ControlPath=/tmp/control-%C',
      '-N',
      '-f',
      'user@code-server',
    ]
  );
});

test('builds SSH config inspection args', () => {
  assert.deepEqual(
    buildSshConfigArgs({
      target: 'user@code-server',
      controlPath: '/tmp/control-%C',
    }),
    ['-G', '-o', 'ControlPath=/tmp/control-%C', 'user@code-server']
  );
});

test('parses SSH config values case-insensitively', () => {
  assert.equal(
    parseSshConfigValue('user test\ncontrolpath /tmp/control-abc\n', 'ControlPath'),
    '/tmp/control-abc'
  );
});

test('builds and parses SSH remote machine probe data', () => {
  assert.deepEqual(
    buildSshRemoteMachineArgs({
      target: 'user@code-server',
      controlPath: '/tmp/control-%C',
    }),
    [
      '-o',
      'ControlPath=/tmp/control-%C',
      'user@code-server',
      'printf "hostname=%s\\n" "$(hostname 2>/dev/null || true)"; printf "addresses=%s\\n" "$(hostname -I 2>/dev/null || hostname -i 2>/dev/null || true)"; printf "platform=%s\\n" "$(uname -s 2>/dev/null || true)"; printf "release=%s\\n" "$(uname -r 2>/dev/null || true)"',
    ]
  );
  assert.deepEqual(
    parseSshRemoteMachine('hostname=code-server\naddresses=10.11.2.10 172.17.0.1\nplatform=Linux\nrelease=6.8.0\n'),
    {
      hostname: 'code-server',
      addresses: ['10.11.2.10', '172.17.0.1'],
      platform: 'Linux',
      release: '6.8.0',
    }
  );
});

test('resolves expanded SSH control path', () => {
  assert.equal(
    resolveSshControlPath({
      target: 'user@code-server',
      controlPath: '/tmp/control-%C',
      spawnSyncImpl: (file, args) => {
        assert.equal(file, 'ssh');
        assert.deepEqual(args, ['-G', '-o', 'ControlPath=/tmp/control-%C', 'user@code-server']);
        return {
          status: 0,
          stdout: 'hostname code-server\ncontrolpath /tmp/control-abc\n',
        };
      },
    }),
    '/tmp/control-abc'
  );
});
