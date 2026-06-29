import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

import { getFreePort } from './chrome.js';

export function createProxyForwardManager(options = {}) {
  return new ProxyForwardManager(options);
}

class ProxyForwardManager {
  constructor({
    sshTarget,
    controlPersist = '24h',
    controlPath,
    quiet = false,
    spawnImpl = spawn,
    getFreePortImpl = getFreePort,
    log = console.log,
  } = {}) {
    this.sshTarget = sshTarget;
    this.controlPersist = controlPersist;
    this.controlPath = controlPath;
    this.quiet = quiet;
    this.spawnImpl = spawnImpl;
    this.getFreePortImpl = getFreePortImpl;
    this.log = (...args) => {
      if (!quiet) log(...args);
    };
    this.forwards = new Map();
  }

  async create({ remotePort, localPort, name } = {}) {
    if (!this.sshTarget) {
      const error = new Error('Proxy forwards require broker --ssh');
      error.statusCode = 400;
      throw error;
    }

    const normalizedRemotePort = normalizePort(remotePort, 'remotePort');
    const normalizedLocalPort = localPort === undefined
      ? await this.getFreePortImpl('127.0.0.1')
      : normalizePort(localPort, 'localPort');

    this.assertNoPortConflict({ remotePort: normalizedRemotePort, localPort: normalizedLocalPort });

    const forward = {
      forwardId: makeForwardId(),
      name,
      remotePort: normalizedRemotePort,
      localPort: normalizedLocalPort,
      proxyServer: `http://127.0.0.1:${normalizedLocalPort}`,
      createdAt: new Date().toISOString(),
    };
    const args = buildProxySshArgs({
      target: this.sshTarget,
      localPort: forward.localPort,
      remotePort: forward.remotePort,
      controlPersist: this.controlPersist,
      controlPath: this.controlPath,
    });
    this.log(
      `Starting SSH proxy forward: local ${forward.localPort} -> remote ${forward.remotePort}`
    );
    const child = this.spawnImpl('ssh', args, { stdio: this.quiet ? 'ignore' : 'inherit' });
    forward.child = child;
    this.forwards.set(forward.forwardId, forward);

    child.on?.('exit', () => {
      if (this.forwards.get(forward.forwardId) === forward && !forward.expectedStop) {
        this.forwards.delete(forward.forwardId);
      }
    });

    return describeForward(forward);
  }

  list(instances = []) {
    return [...this.forwards.values()].map((forward) =>
      describeForward(forward, inUseBy(forward.forwardId, instances))
    );
  }

  get(forwardId, instances = []) {
    const forward = this.forwards.get(forwardId);
    if (!forward) return undefined;
    return describeForward(forward, inUseBy(forward.forwardId, instances));
  }

  delete(forwardId, instances = []) {
    const forward = this.forwards.get(forwardId);
    if (!forward) {
      const error = new Error(`Unknown proxy forward: ${forwardId}`);
      error.statusCode = 404;
      throw error;
    }

    const usedBy = inUseBy(forwardId, instances);
    if (usedBy.length) {
      const error = new Error(`Proxy forward is in use: ${forwardId}`);
      error.statusCode = 409;
      throw error;
    }

    forward.expectedStop = true;
    if (forward.child && !forward.child.killed) {
      forward.child.kill('SIGTERM');
    }
    this.forwards.delete(forwardId);
    return { deleted: true, forwardId };
  }

  stopAll() {
    let count = 0;
    for (const forward of this.forwards.values()) {
      forward.expectedStop = true;
      if (forward.child && !forward.child.killed) {
        forward.child.kill('SIGTERM');
      }
      count += 1;
    }
    this.forwards.clear();
    return count;
  }

  assertNoPortConflict({ remotePort, localPort }) {
    for (const forward of this.forwards.values()) {
      if (forward.localPort === localPort) {
        const error = new Error(`Proxy localPort is already in use: ${localPort}`);
        error.statusCode = 409;
        throw error;
      }
      if (forward.remotePort === remotePort) {
        const error = new Error(`Proxy remotePort is already forwarded: ${remotePort}`);
        error.statusCode = 409;
        throw error;
      }
    }
  }
}

export function buildProxySshArgs({
  target,
  localPort,
  remotePort,
  controlPersist,
  controlPath,
}) {
  return [
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPersist=${controlPersist}`,
    '-o',
    `ControlPath=${controlPath}`,
    '-o',
    'ExitOnForwardFailure=yes',
    '-N',
    '-L',
    `${localPort}:localhost:${remotePort}`,
    target,
  ];
}

function normalizePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const error = new Error(`${name} must be a TCP port between 1 and 65535`);
    error.statusCode = 400;
    throw error;
  }
  return port;
}

function describeForward(forward, usedBy = []) {
  return {
    forwardId: forward.forwardId,
    name: forward.name,
    remotePort: forward.remotePort,
    localPort: forward.localPort,
    proxyServer: forward.proxyServer,
    createdAt: forward.createdAt,
    inUseBy: usedBy,
  };
}

function inUseBy(forwardId, instances) {
  return instances
    .filter((instance) => instance.proxyForwardId === forwardId)
    .map((instance) => instance.id);
}

function makeForwardId() {
  return `pf_${crypto.randomBytes(16).toString('base64url')}`;
}
