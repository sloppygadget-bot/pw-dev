import path from 'node:path';

import { brokerHome } from './chrome.js';

const PROFILE_PATTERN = /^[A-Za-z0-9._-]+$/;

export function validateProfileName(name) {
  if (!name || !PROFILE_PATTERN.test(name)) {
    throw new Error(
      '--profile must contain only letters, numbers, dot, underscore, and dash'
    );
  }
  if (name === '.' || name === '..') {
    throw new Error('--profile cannot be "." or ".."');
  }
}

export function profileDirForName(name) {
  validateProfileName(name);
  return path.join(brokerHome(), 'profiles', name);
}
