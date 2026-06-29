import assert from 'node:assert/strict';
import test from 'node:test';

import { profileDirForName, validateProfileName } from '../src/profiles.js';

test('validates safe profile names', () => {
  assert.doesNotThrow(() => validateProfileName('work-okta_1.2'));
  assert.throws(() => validateProfileName('../default'), /--profile/);
  assert.throws(() => validateProfileName(''), /--profile/);
  assert.throws(() => validateProfileName('..'), /--profile/);
});

test('maps profile names under broker home', () => {
  const dir = profileDirForName('work-okta');
  assert.match(dir, /\/\.pw-cdp-broker\/profiles\/work-okta$/);
});
