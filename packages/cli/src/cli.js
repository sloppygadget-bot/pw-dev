// @ts-check

import { main as brokerMain } from '../../cdp-broker/src/cli.js';
import { main as serverMain } from '../../server/src/cli.js';

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

  throw new Error(`Unknown command: ${command}`);
}

export function helpText() {
  return `pw-dev

Usage:
  pw-dev <command> [options]

Commands:
  broker      Run the local/remote Chrome session broker
  server      Run the dependency-free static dev server

Examples:
  pw-dev broker --profile work-okta
  pw-dev server --root examples/static-site --port 3100`;
}
