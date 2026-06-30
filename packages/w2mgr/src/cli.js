// @ts-check

import { createW2Mgr, startW2MgrServer } from './index.js';

const DEFAULT_PORT = 18081;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_SERVER_URL = 'http://127.0.0.1:9696';
const DEFAULT_PROXY_PORT_RANGE = '8888-8899';

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }

  const manager = createW2Mgr({
    serverUrl: options.serverUrl,
    w2Command: options.w2Command,
    proxyPortRange: options.proxyPortRange,
    quiet: options.quiet,
  });
  const server = await startW2MgrServer({
    manager,
    host: options.host,
    port: options.port,
  });

  if (!options.quiet) {
    console.log(`pw-dev w2mgr listening: ${server.origin}`);
    console.log(`pw-dev server registry: ${manager.serverUrl}`);
  }

  if (options.autoStart) {
    await manager.startAll();
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
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--quiet') {
      options.quiet = true;
    } else if (arg === '--auto-start') {
      options.autoStart = true;
    } else if (arg === '--host') {
      options.host = readValue(argv, ++i, arg);
    } else if (arg === '--port') {
      options.port = parsePort(readValue(argv, ++i, arg), arg);
    } else if (arg === '--server-url') {
      options.serverUrl = readValue(argv, ++i, arg);
    } else if (arg === '--w2-command') {
      options.w2Command = readValue(argv, ++i, arg);
    } else if (arg === '--proxy-port-range') {
      options.proxyPortRange = readValue(argv, ++i, arg);
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
  return `pw-dev w2mgr

Usage:
  pw-dev w2mgr [options]

Options:
  --host <host>       Listen host. Default: 127.0.0.1
  --port <port>       Listen port. Default: 18081
  --server-url <url>  pw-dev server URL. Default: http://127.0.0.1:9696
  --w2-command <cmd>  Whistle command. Default: w2
  --proxy-port-range <start-end>
                      Whistle port pool. Default: 8888-8899
  --auto-start        Start registered app devservers and Whistle proxies on boot
  --quiet             Reduce process logging
  --help              Show this help`;
}
