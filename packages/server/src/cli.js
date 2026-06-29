// @ts-check

/**
 * Command-line entry point for `pw-dev server`.
 *
 * The CLI starts the same HTTP server exported by `src/index.js` and maps
 * scalar flags onto the seeded app manifest/registry entry.
 */

import path from 'node:path';
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

  const server = await startPwDevServer(options);
  console.log(`pw-dev server listening: ${server.origin}`);
  console.log(`root: ${server.root}`);

  const shutdown = async (signal) => {
    console.log(`Received ${signal}; shutting down.`);
    await server.close();
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * Parse `pw-dev server` flags.
 *
 * These options seed the default app registration. Additional apps should use
 * `POST /_pwdev/apps` at runtime.
 *
 * @param {string[]} argv Command-line arguments after `pw-dev server`.
 * @returns {import('./index.js').PwDevServerOptions & { help?: boolean }}
 */
export function parseArgs(argv) {
  const options = {};
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
    } else if (arg === '--broker-url') {
      options.brokerUrl = readValue(argv, ++i, arg);
    } else if (arg === '--cdp-url') {
      options.cdpUrl = readValue(argv, ++i, arg);
    } else if (arg === '--profile') {
      options.profile = readValue(argv, ++i, arg);
    } else if (arg === '--proxy-forward-id') {
      options.proxyForwardId = readValue(argv, ++i, arg);
    } else if (arg === '--proxy-server') {
      options.proxyServer = readValue(argv, ++i, arg);
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
  --broker-url <url>
                  Pair this server with a pw-dev broker
  --cdp-url <url>  CDP URL for browser automation
  --profile <name> Broker profile for browser automation
  --proxy-forward-id <id>
                  Broker proxy-forward id for proxied app sessions
  --proxy-server <url>
                  Explicit Chrome proxy server for app browser sessions
  --help          Show this help`;
}
