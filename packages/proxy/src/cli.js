// @ts-check

import { createProxyManager, startProxyManagerServer } from './index.js';

const DEFAULT_PORT = 18081;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_SERVER_URL = 'http://127.0.0.1:9696';
const DEFAULT_PROXY_PORT_RANGE = '8888-8899';
const DEFAULT_UI_PORT_RANGE = '9800-9899';

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }

  const manager = createProxyManager({
    serverUrl: options.serverUrl,
    w2Command: options.w2Command,
    w2StorageRoot: options.w2StorageRoot,
    proxyPortRange: options.proxyPortRange,
    uiPortRange: options.uiPortRange,
    quiet: options.quiet,
  });
  const server = await startProxyManagerServer({
    manager,
    host: options.host,
    port: options.port,
  });

  if (!options.quiet) {
    console.log(`pw-dev proxy listening: ${server.origin}`);
    console.log(`pw-dev server registry: ${manager.serverUrl}`);
  }

  const shutdown = async (signal) => {
    if (!options.quiet) console.log(`Received ${signal}; shutting down.`);
    await manager.stopAll();
    await server.close();
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

export function parseArgs(argv) {
  const options = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    serverUrl: DEFAULT_SERVER_URL,
    proxyPortRange: DEFAULT_PROXY_PORT_RANGE,
    uiPortRange: DEFAULT_UI_PORT_RANGE,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--quiet') {
      options.quiet = true;
    } else if (arg === '--host') {
      options.host = readValue(argv, ++i, arg);
    } else if (arg === '--port') {
      options.port = parsePort(readValue(argv, ++i, arg), arg);
    } else if (arg === '--server-url') {
      options.serverUrl = readValue(argv, ++i, arg);
    } else if (arg === '--w2-command') {
      options.w2Command = readValue(argv, ++i, arg);
    } else if (arg === '--w2-storage-root') {
      options.w2StorageRoot = readValue(argv, ++i, arg);
    } else if (arg === '--proxy-port-range') {
      options.proxyPortRange = readValue(argv, ++i, arg);
    } else if (arg === '--ui-port-range') {
      options.uiPortRange = readValue(argv, ++i, arg);
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
  return `pw-dev proxy

Usage:
  pw-dev proxy [options]

Options:
  --host <host>       Listen host. Default: 127.0.0.1
  --port <port>       Listen port. Default: 18081
  --server-url <url>  pw-dev server URL. Default: http://127.0.0.1:9696
  --w2-command <cmd>  Whistle command override. Default: bundled whistle
  --w2-storage-root <path>
                      Root for per-proxy Whistle -S storage.
                      Default: packages/proxy/.runtime/whistle
  --proxy-port-range <start-end>
                      Whistle port pool. Default: 8888-8899
  --ui-port-range <start-end>
                      Whistle GUI port pool. Default: 9800-9899
  --quiet             Reduce process logging
  --help              Show this help`;
}
