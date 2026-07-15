import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBrowserManager } from './browser-manager.js';
import { createNetworkManager } from './networks.js';
import { createProxyForwardManager } from './proxy-forwards.js';
import { createBrokerServer } from './server.js';
import { findChromeExecutable } from './chrome.js';
import { validateProfileName } from './profiles.js';

const DEFAULT_BROKER_PORT = 18080;
const DEFAULT_PROFILE = 'default';
const DEFAULT_SSH_CONTROL_PERSIST = '24h';

export async function main(argv) {
  const options = parseArgs(argv);

  if (options.help) {
    printHelp();
    return;
  }

  if (options.profile && options.userDataDir) {
    throw new Error('--profile and --user-data-dir are mutually exclusive');
  }

  const brokerPort = Number(options.port ?? DEFAULT_BROKER_PORT);
  assertPort(brokerPort, '--port');
  const brokerRemotePort = Number(options.sshRemotePort ?? brokerPort);
  if (options.sshRemotePort !== undefined) assertPort(brokerRemotePort, '--ssh-remote-port');

  const chromeDebugPort = options.chromePort ? Number(options.chromePort) : undefined;
  if (chromeDebugPort !== undefined) assertPort(chromeDebugPort, '--chrome-port');

  const defaultProfile = options.profile ?? (options.standby ? undefined : DEFAULT_PROFILE);
  const defaultUserDataDir = options.userDataDir
    ? path.resolve(options.userDataDir)
    : undefined;
  const sshProxyForward = parseSshProxyForward(options);
  const proxyServer =
    options.proxyServer ||
    (sshProxyForward ? `http://127.0.0.1:${sshProxyForward.localPort}` : undefined);
  const sshControlPersist = options.sshControlPersist ?? DEFAULT_SSH_CONTROL_PERSIST;
  const sshControlPath = options.ssh ? prepareSshControlPath() : undefined;

  if (defaultProfile) {
    validateProfileName(defaultProfile);
  }

  const chromeExecutable =
    options.chromeExecutable || findChromeExecutable(process.env.CHROME_PATH);
  if (!chromeExecutable) {
    throw new Error(
      'Could not find Chrome/Chromium. Pass --chrome-executable or set CHROME_PATH.'
    );
  }

  const children = new Set();
  let server;
  let shuttingDown = false;
  const log = (...args) => {
    if (!options.quiet) console.log(...args);
  };

  const browserManager = createBrowserManager({
    chromeExecutable,
    defaultProfile,
    defaultUserDataDir,
    defaultChromePort: chromeDebugPort,
    headless: Boolean(options.headless),
    proxyServer,
    proxyBypassList: options.proxyBypassList,
    ignoreSslErrors: Boolean(options.ignoreSslErrors),
    extraArgs: options.chromeArg,
    quiet: Boolean(options.quiet),
    onUnexpectedExit: ({ code, signal }) => {
      if (shuttingDown) return;
      console.error(`Chrome exited unexpectedly: code=${code} signal=${signal}`);
      if (!options.standby) void shutdown();
    },
  });
  const proxyForwardManager = createProxyForwardManager({
    sshTarget: options.ssh,
    controlPersist: sshControlPersist,
    controlPath: sshControlPath,
    quiet: Boolean(options.quiet),
  });
  const networkManager = createNetworkManager({ proxyForwardManager });

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (signal) log(`Received ${signal}; shutting down.`);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await browserManager.stopAll();
    proxyForwardManager.stopAll();
    for (const child of children) {
      if (!child.killed) child.kill('SIGTERM');
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  let initialInstance;
  if (!options.standby) {
    initialInstance = await browserManager.start({
      profile: defaultProfile,
      resetProfile: Boolean(options.resetProfile),
    });
  }

  let sshRemoteMachine;
  if (options.ssh) {
    ensureSshControlMaster({
      target: options.ssh,
      controlPersist: sshControlPersist,
      controlPath: sshControlPath,
      quiet: Boolean(options.quiet),
    });
    sshRemoteMachine = inspectSshRemoteMachine({
      target: options.ssh,
      controlPath: sshControlPath,
    });
  }

  server = createBrokerServer({
    browserManager,
    proxyForwardManager,
    networkManager,
    topology: options.ssh ? {
      mode: 'ssh',
      remote: true,
      ssh: {
        target: options.ssh,
        remotePort: brokerRemotePort,
        controlPersist: sshControlPersist,
        remoteMachine: sshRemoteMachine,
      },
    } : undefined,
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(brokerPort, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const listenHost =
    typeof address === 'object' && address ? address.address : options.host ?? '127.0.0.1';
  log(`CDP broker listening: http://${listenHost}:${brokerPort}`);
  if (options.standby) {
    log(`Broker standby start endpoint: http://${listenHost}:${brokerPort}/_broker/start`);
  } else {
    log(`Remote Playwright: chromium.connectOverCDP('http://127.0.0.1:${brokerPort}')`);
    log(
      `Remote Playwright instance URL: chromium.connectOverCDP('http://127.0.0.1:${brokerPort}/_broker/instances/${initialInstance.id}')`
    );
  }

  if (options.ssh) {
    const ssh = startSshTunnel({
      target: options.ssh,
      localPort: brokerPort,
      remotePort: brokerRemotePort,
      controlPersist: sshControlPersist,
      controlPath: sshControlPath,
      proxyForward: sshProxyForward,
      quiet: Boolean(options.quiet),
    });
    children.add(ssh);
    ssh.on('exit', (code, signal) => {
      children.delete(ssh);
      if (!shuttingDown) {
        console.error(`ssh tunnel exited: code=${code} signal=${signal}`);
      }
    });
  }
}

export function parseArgs(argv) {
  const options = {
    chromeArg: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--headless') {
      options.headless = true;
    } else if (arg === '--reset-profile') {
      options.resetProfile = true;
    } else if (arg === '--ignore-ssl-errors') {
      options.ignoreSslErrors = true;
    } else if (arg === '--quiet') {
      options.quiet = true;
    } else if (arg === '--standby') {
      options.standby = true;
    } else if (arg.startsWith('--')) {
      const [name, inlineValue] = arg.split('=', 2);
      const value = inlineValue ?? argv[++i];
      if (value === undefined) throw new Error(`${name} requires a value`);
      switch (name) {
        case '--port':
          options.port = value;
          break;
        case '--host':
          options.host = value;
          break;
        case '--chrome-port':
          options.chromePort = value;
          break;
        case '--profile':
          options.profile = value;
          break;
        case '--user-data-dir':
          options.userDataDir = value;
          break;
        case '--chrome-executable':
          options.chromeExecutable = value;
          break;
        case '--chrome-arg':
          options.chromeArg.push(value);
          break;
        case '--proxy-server':
          options.proxyServer = value;
          break;
        case '--proxy-bypass-list':
          options.proxyBypassList = value;
          break;
        case '--ssh':
          options.ssh = value;
          break;
        case '--ssh-remote-port':
          options.sshRemotePort = value;
          break;
        case '--ssh-control-persist':
          options.sshControlPersist = value;
          break;
        case '--ssh-proxy-remote-port':
          options.sshProxyRemotePort = value;
          break;
        case '--ssh-proxy-local-port':
          options.sshProxyLocalPort = value;
          break;
        default:
          throw new Error(`Unknown option: ${name}`);
      }
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return options;
}

function parseSshProxyForward(options) {
  if (!options.sshProxyRemotePort && !options.sshProxyLocalPort) {
    return undefined;
  }
  if (!options.ssh) {
    throw new Error('--ssh-proxy-remote-port requires --ssh');
  }
  if (!options.sshProxyRemotePort) {
    throw new Error('--ssh-proxy-local-port requires --ssh-proxy-remote-port');
  }

  const remotePort = Number(options.sshProxyRemotePort);
  assertPort(remotePort, '--ssh-proxy-remote-port');
  const localPort = options.sshProxyLocalPort
    ? Number(options.sshProxyLocalPort)
    : remotePort;
  assertPort(localPort, '--ssh-proxy-local-port');
  return { localPort, remotePort };
}

function assertPort(port, name) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a TCP port between 1 and 65535`);
  }
}

function prepareSshControlPath() {
  const controlDir = path.join(os.homedir(), '.pw-cdp-broker', 'ssh');
  fs.mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  return path.join(controlDir, '%C');
}

function startSshTunnel({
  target,
  localPort,
  remotePort,
  controlPersist,
  controlPath,
  proxyForward,
  quiet,
}) {
  assertPort(remotePort, '--ssh-remote-port');
  const log = (...args) => {
    if (!quiet) console.log(...args);
  };
  const args = buildSshArgs({
    target,
    localPort,
    remotePort,
    controlPath,
    proxyForward,
    controlCommand: 'forward',
  });

  log(`Requesting SSH reverse tunnel: ${target} remote ${remotePort} -> local ${localPort}`);
  if (proxyForward) {
    log(
      `Requesting SSH proxy forward: local ${proxyForward.localPort} -> remote ${proxyForward.remotePort}`
    );
  }
  log(`SSH ControlPersist: ${controlPersist}`);
  const result = spawnSync('ssh', args, { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`ssh forward request exited with status ${result.status}`);
  }
  return makeSshForwardHandle({
    target,
    localPort,
    remotePort,
    controlPath,
    proxyForward,
    quiet,
  });
}

function makeSshForwardHandle({ target, localPort, remotePort, controlPath, proxyForward, quiet }) {
  return {
    killed: false,
    on() {
      return this;
    },
    kill() {
      if (this.killed) return;
      this.killed = true;
      const result = spawnSync(
        'ssh',
        buildSshArgs({
          target,
          localPort,
          remotePort,
          controlPath,
          proxyForward,
          controlCommand: 'cancel',
        }),
        { stdio: quiet ? 'ignore' : 'inherit' }
      );
      if (result.error && !quiet) {
        console.error(`ssh forward cancel failed: ${result.error.message}`);
      }
    },
  };
}

function ensureSshControlMaster({ target, controlPersist, controlPath, quiet }) {
  const check = spawnSync('ssh', buildSshControlCheckArgs({ target, controlPath }), {
    stdio: 'ignore',
  });
  if (check.status === 0) {
    if (!quiet) console.log(`SSH control master already active: ${target}`);
    return;
  }
  if (check.error) {
    throw check.error;
  }
  removeStaleSshControlSocket({ target, controlPath, quiet });

  if (!quiet) {
    console.log(`Starting SSH control master: ${target}`);
    console.log(`SSH ControlPersist: ${controlPersist}`);
  }
  const master = spawnSync(
    'ssh',
    buildSshControlMasterArgs({ target, controlPersist, controlPath }),
    { stdio: 'inherit' }
  );
  if (master.error) {
    throw master.error;
  }
  if (master.status !== 0) {
    throw new Error(`ssh control master exited with status ${master.status}`);
  }
}

function removeStaleSshControlSocket({ target, controlPath, quiet }) {
  const socketPath = resolveSshControlPath({ target, controlPath });
  if (!socketPath || socketPath === 'none') return;

  let stat;
  try {
    stat = fs.lstatSync(socketPath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  if (!stat.isSocket()) return;
  fs.unlinkSync(socketPath);
  if (!quiet) console.log(`Removed stale SSH control socket: ${socketPath}`);
}

export function resolveSshControlPath({ target, controlPath, spawnSyncImpl = spawnSync }) {
  const result = spawnSyncImpl('ssh', buildSshConfigArgs({ target, controlPath }), {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return undefined;
  return parseSshConfigValue(result.stdout, 'controlpath');
}

export function buildSshRemoteMachineArgs({ target, controlPath }) {
  return [
    '-o',
    `ControlPath=${controlPath}`,
    target,
    [
      'printf "hostname=%s\\n" "$(hostname 2>/dev/null || true)"',
      'printf "addresses=%s\\n" "$(hostname -I 2>/dev/null || hostname -i 2>/dev/null || true)"',
      'printf "platform=%s\\n" "$(uname -s 2>/dev/null || true)"',
      'printf "release=%s\\n" "$(uname -r 2>/dev/null || true)"',
    ].join('; '),
  ];
}

export function parseSshRemoteMachine(output) {
  const values = {};
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (value) values[key] = value;
  }

  const remoteMachine = {
    hostname: values.hostname,
    addresses: values.addresses?.split(/\s+/).filter(Boolean),
    platform: values.platform,
    release: values.release,
  };
  return Object.fromEntries(
    Object.entries(remoteMachine).filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : value !== undefined
    )
  );
}

function inspectSshRemoteMachine({ target, controlPath }) {
  const result = spawnSync('ssh', buildSshRemoteMachineArgs({ target, controlPath }), {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.error || result.status !== 0) {
    return {
      error: result.error?.message || String(result.stderr || '').trim() || 'Remote machine probe failed',
    };
  }
  return parseSshRemoteMachine(result.stdout);
}

export function buildSshControlCheckArgs({ target, controlPath }) {
  return ['-o', `ControlPath=${controlPath}`, '-O', 'check', target];
}

export function buildSshConfigArgs({ target, controlPath }) {
  return ['-G', '-o', `ControlPath=${controlPath}`, target];
}

export function buildSshControlMasterArgs({ target, controlPersist, controlPath }) {
  return [
    '-o',
    'ControlMaster=yes',
    '-o',
    `ControlPersist=${controlPersist}`,
    '-o',
    `ControlPath=${controlPath}`,
    '-N',
    '-f',
    target,
  ];
}

export function parseSshConfigValue(output, key) {
  const prefix = `${key.toLowerCase()} `;
  return output
    .split('\n')
    .find((line) => line.toLowerCase().startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

export function buildSshArgs({
  target,
  localPort,
  remotePort,
  controlPath,
  proxyForward,
  controlCommand = 'forward',
}) {
  const args = [
    '-o',
    `ControlPath=${controlPath}`,
    '-o',
    'ExitOnForwardFailure=yes',
    '-O',
    controlCommand,
  ];

  if (proxyForward) {
    args.push('-L', `${proxyForward.localPort}:localhost:${proxyForward.remotePort}`);
  }

  args.push('-R', `${remotePort}:localhost:${localPort}`, target);
  return args;
}

function printHelp() {
  console.log(`pw-cdp-broker

Launch a local visible Chrome and expose a Chrome-compatible CDP endpoint for
remote Playwright clients.

Usage:
  pw-cdp-broker [options]

Options:
  --port <port>                 Broker CDP port. Default: ${DEFAULT_BROKER_PORT}
  --host <host>                 Broker listen host. Default: 127.0.0.1
  --profile <name>              Named broker profile. Default: ${DEFAULT_PROFILE}
  --user-data-dir <path>        Explicit Chrome profile path; exclusive with --profile
  --reset-profile               Delete the selected profile before launch
  --chrome-port <port>          Chrome remote debugging port. Default: random free port
  --chrome-executable <path>    Chrome/Chromium executable path
  --chrome-arg <arg>            Extra Chrome arg; repeatable
  --proxy-server <server>       Chrome proxy server, e.g. http://127.0.0.1:8899
  --proxy-bypass-list <rules>   Chrome proxy bypass list
  --ignore-ssl-errors           Ignore HTTPS certificate errors in Chrome
  --quiet                       Suppress broker status logs and Chrome output
  --standby                     Listen for broker control requests without launching Chrome
  --headless                    Launch Chrome headless
  --ssh <user@host>             Start an SSH reverse tunnel to a code-server host
  --ssh-remote-port <port>      Remote tunnel port. Default: same as --port
  --ssh-proxy-remote-port <p>   Forward remote proxy port to local Chrome
  --ssh-proxy-local-port <p>    Local forwarded proxy port. Default: same as remote
  --ssh-control-persist <time>  OpenSSH ControlPersist value. Default: 24h
  --help                        Show this help

Examples:
  pw-cdp-broker --profile work-okta
  pw-cdp-broker --profile work-okta --ssh user@code-server

Remote Playwright:
  await chromium.connectOverCDP('http://127.0.0.1:${DEFAULT_BROKER_PORT}');
`);
}
