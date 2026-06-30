import assert from 'node:assert/strict';
import test from 'node:test';

import { helpText, main } from '../src/cli.js';

test('help text lists supported commands', () => {
  assert.match(helpText(), /broker/);
  assert.match(helpText(), /server/);
  assert.match(helpText(), /w2mgr/);
});

test('main rejects unknown commands', async () => {
  await assert.rejects(() => main(['unknown']), /Unknown command/);
});
