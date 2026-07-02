// @ts-check

import { main as brokerMain } from '../../cdp-broker/src/cli.js';
import { main as serverMain } from '../../server/src/cli.js';
import { main as proxyMain } from '../../proxy/src/cli.js';

export async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    console.log(helpText());
    return;
  }

  if (command === 'broker' || command === 'cdp-broker') {
    await brokerMain(rest);
    return;
  }

  if (command === 'server') {
    await serverMain(rest);
    return;
  }

  if (command === 'proxy' || command === 'w2') {
    await proxyMain(rest);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

export function helpText() {
  return `pw-dev

Usage:
  pw-dev <command> [options]

Commands:
  broker      Run the local/remote Chrome session broker
  server      Run the dependency-free static dev server
  proxy       Run the optional managed Whistle proxy manager

Examples:
  pw-dev broker --profile work-okta
  pw-dev server --root examples/static-site --port 9696
  pw-dev proxy`;
}
