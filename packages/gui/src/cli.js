// @ts-check

import { startPwDevGuiServer } from './server.js';

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }

  const server = await startPwDevGuiServer(options);
  console.log(`pw-dev gui listening: ${server.origin}`);
  console.log(`pw-dev target: ${server.pwDevUrl}`);

  const shutdown = async (signal) => {
    console.log(`Received ${signal}; shutting down.`);
    await server.close();
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

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
    } else if (arg === '--pwdev-url' || arg === '--server-url') {
      options.pwDevUrl = readValue(argv, ++i, arg);
    } else if (arg === '--broker-url') {
      options.brokerUrl = readValue(argv, ++i, arg);
    } else if (arg === '--proxy-manager-url') {
      options.proxyManagerUrl = readValue(argv, ++i, arg);
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
  return `pw-dev gui

Usage:
  pw-dev gui [options]

Options:
  --host <host>        Listen host. Default: 127.0.0.1
  --port <port>        Listen port. Default: 9797
  --pwdev-url <url>    pw-dev server URL. Default: http://127.0.0.1:9696
  --server-url <url>   Alias for --pwdev-url
  --broker-url <url>   Broker URL. Default: http://127.0.0.1:18080
  --proxy-manager-url <url>
                       Proxy manager URL. Default: http://127.0.0.1:9697
  --help               Show this help`;
}
