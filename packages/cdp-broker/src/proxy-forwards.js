import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';

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

  async check(forwardId, options = {}) {
    const forward = this.forwards.get(forwardId);
    if (!forward) return undefined;
    return probeHttpProxy(forward, options);
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

async function probeHttpProxy(forward, {
  host = 'example.com',
  port = 80,
  timeoutMs = 3000,
} = {}) {
  const startedAt = Date.now();
  const probeHost = normalizeProbeHost(host);
  const probePort = normalizeProbePort(port);
  const target = `${probeHost}:${probePort}`;
  const timeout = normalizeProbeTimeout(timeoutMs);

  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: forward.localPort });
    let settled = false;
    let response = '';

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        forwardId: forward.forwardId,
        localPort: forward.localPort,
        remotePort: forward.remotePort,
        target,
        latencyMs: Date.now() - startedAt,
        ...result,
      });
    };

    socket.setTimeout(timeout, () => finish({
      reachable: false,
      error: `probe timed out after ${timeout}ms`,
    }));
    socket.once('error', (error) => finish({
      reachable: false,
      error: error.code || error.message,
    }));
    socket.on('data', (chunk) => {
      response += chunk.toString('latin1');
      if (response.length > 64 * 1024) {
        finish({ reachable: false, error: 'probe response headers exceeded 64KiB' });
        return;
      }
      const headerEnd = response.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const statusLine = response.slice(0, headerEnd).split('\r\n', 1)[0];
      const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s|$)/.exec(statusLine);
      if (!match) {
        finish({ reachable: false, error: 'remote endpoint did not return an HTTP response' });
        return;
      }
      finish({ reachable: true, statusCode: Number(match[1]) });
    });
    socket.once('connect', () => {
      socket.write([
        `CONNECT ${target} HTTP/1.1`,
        `Host: ${target}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n'));
    });
  });
}

function normalizeProbeTimeout(value) {
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000) {
    const error = new Error('timeoutMs must be an integer between 100 and 30000');
    error.statusCode = 400;
    throw error;
  }
  return timeout;
}

function normalizeProbeHost(value) {
  if (typeof value !== 'string' || !value || /[\r\n\s]/.test(value)) {
    const error = new Error('host must be a non-empty hostname without whitespace');
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function normalizeProbePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const error = new Error('port must be an integer between 1 and 65535');
    error.statusCode = 400;
    throw error;
  }
  return port;
}
