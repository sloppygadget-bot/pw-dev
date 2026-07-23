// @ts-check

/**
 * Command-line entry point for `pw-dev server`.
 *
 * The CLI starts the same HTTP server exported by `src/index.js` and maps
 * scalar flags onto the root manifest. App registry entries are created
 * through `POST /_pwdev/apps` unless `--register-default-app` is supplied.
 */

import path from 'node:path';
import { createProxyManager, startProxyManagerServer } from '../../proxy/src/index.js';
import { startPwDevServer } from './index.js';

/**
 * Run the server CLI.
 *
 * @param {string[]} argv Command-line arguments after `pw-dev server`.
 * @returns {Promise<void>}
 */
export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }

  const proxyManagerUrl = options.proxyManagerUrl ?? `http://${options.proxyManagerHost}:${options.proxyManagerPort}`;
  let proxyManager;
  let proxyManagerServer;
  let proxyManagerStartPromise;
  const ownsProxyManager = options.startProxyManager && !options.proxyManagerUrl;
  let server;
  const ensureProxyManager = ownsProxyManager
    ? async () => {
        if (proxyManagerServer) return proxyManagerServer;
        if (!proxyManagerStartPromise) {
          proxyManagerStartPromise = (async () => {
            try {
              proxyManager = createProxyManager({ serverUrl: server.origin });
              proxyManagerServer = await startProxyManagerServer({
                manager: proxyManager,
                host: options.proxyManagerHost,
                port: options.proxyManagerPort,
              });
              console.log(`pw-dev proxy listening: ${proxyManagerServer.origin}`);
              return proxyManagerServer;
            } catch (error) {
              await proxyManager?.stopAll?.();
              proxyManager = undefined;
              proxyManagerServer = undefined;
              throw error;
            } finally {
              proxyManagerStartPromise = undefined;
            }
          })();
        }
        return proxyManagerStartPromise;
      }
    : undefined;
  server = await startPwDevServer({ ...options, proxyManagerUrl, ensureProxyManager });
  console.log(`pw-dev server listening: ${server.origin}`);
  console.log(`root: ${server.root}`);

  let shutdownPromise;
  const shutdown = async (signal) => {
    if (shutdownPromise) return shutdownPromise;
    console.log(`Received ${signal}; shutting down.`);
    shutdownPromise = (async () => {
      if (proxyManager) await proxyManager.stopAll({ preserve: true });
      await server.close();
      if (proxyManagerServer) await proxyManagerServer.close();
    })();
    return shutdownPromise;
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * Parse `pw-dev server` flags.
 *
 * These options seed the root manifest. Additional apps should use
 * `POST /_pwdev/apps` at runtime.
 *
 * @param {string[]} argv Command-line arguments after `pw-dev server`.
 * @returns {import('./index.js').PwDevServerOptions & { help?: boolean }}
 */
export function parseArgs(argv) {
  const options = {};
  options.proxyManagerHost = '127.0.0.1';
  options.proxyManagerPort = 9697;
  options.startProxyManager = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--host') {
      options.host = readValue(argv, ++i, arg);
    } else if (arg === '--port' || arg === '-p') {
      options.port = parsePort(readValue(argv, ++i, arg), arg);
    } else if (arg === '--root' || arg === '-r') {
      options.root = path.resolve(readValue(argv, ++i, arg));
    } else if (arg === '--id') {
      options.id = readValue(argv, ++i, arg);
    } else if (arg === '--name') {
      options.name = readValue(argv, ++i, arg);
    } else if (arg === '--worktree') {
      options.worktree = path.resolve(readValue(argv, ++i, arg));
    } else if (arg === '--branch') {
      options.branch = readValue(argv, ++i, arg);
    } else if (arg === '--app-url') {
      options.appUrl = readValue(argv, ++i, arg);
    } else if (arg === '--app-registry-file') {
      options.appRegistryFile = path.resolve(readValue(argv, ++i, arg));
    } else if (arg === '--broker-url') {
      options.brokerUrl = readValue(argv, ++i, arg);
    } else if (arg === '--proxy-manager-url') {
      options.proxyManagerUrl = readValue(argv, ++i, arg);
    } else if (arg === '--proxy-manager-host') {
      options.proxyManagerHost = readValue(argv, ++i, arg);
    } else if (arg === '--proxy-manager-port') {
      options.proxyManagerPort = parsePort(readValue(argv, ++i, arg), arg);
    } else if (arg === '--no-proxy-manager') {
      options.startProxyManager = false;
    } else if (arg === '--cdp-url') {
      options.cdpUrl = readValue(argv, ++i, arg);
    } else if (arg === '--proxy-forward-id') {
      options.proxyForwardId = readValue(argv, ++i, arg);
    } else if (arg === '--proxy-server') {
      options.proxyServer = readValue(argv, ++i, arg);
    } else if (arg === '--register-default-app') {
      options.registerDefaultApp = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function readValue(argv, index, flag) {
  if (index >= argv.length) throw new Error(`${flag} requires a value`);
  return argv[index];
}

function parsePort(value, flag) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${flag} must be a TCP port between 1 and 65535`);
  }
  return port;
}

export function helpText() {
  return `pw-dev server

Usage:
  pw-dev server [options]

Options:
  --host <host>   Listen host. Default: 127.0.0.1
  --port <port>   Listen port. Default: 9696
  --root <dir>    Static root. Default: current directory
  --id <id>        App id for /_pwdev/manifest
  --name <name>    App display name for /_pwdev/manifest
  --worktree <dir> Worktree path for /_pwdev/manifest. Default: root
  --branch <name>  Branch name for /_pwdev/manifest
  --app-url <url>  App URL. Default: this server origin
  --app-registry-file <file>
                  Durable app registry. Default: <worktree>/.pw-dev/apps.json
  --broker-url <url>
                  Broker URL. Default: http://127.0.0.1:18080
  --proxy-manager-url <url>
                  Existing proxy manager URL; disables automatic startup
  --proxy-manager-host <host>
                  Local proxy manager listen host. Default: 127.0.0.1
  --proxy-manager-port <port>
                  Local proxy manager listen port. Default: 9697
  --no-proxy-manager
                  Disable automatic proxy-manager startup and shutdown
  --cdp-url <url>  CDP URL for browser automation
  --proxy-forward-id <id>
                  Broker proxy-forward id for proxied app sessions
  --proxy-server <url>
                  Explicit Chrome proxy server for app browser sessions
  --register-default-app
                  Also register /_pwdev/manifest in /_pwdev/apps
  --help          Show this help`;
}
