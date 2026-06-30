// @ts-check

import { main as brokerMain } from '../../cdp-broker/src/cli.js';
import { main as serverMain } from '../../server/src/cli.js';
import { main as w2mgrMain } from '../../w2mgr/src/cli.js';

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

  if (command === 'w2mgr' || command === 'w2') {
    await w2mgrMain(rest);
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
  w2mgr       Run the optional app and Whistle process manager

Examples:
  pw-dev broker --profile work-okta
  pw-dev server --root examples/static-site --port 9696
  pw-dev w2mgr --auto-start`;
}
