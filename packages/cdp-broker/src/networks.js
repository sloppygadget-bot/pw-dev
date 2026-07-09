export function createNetworkManager(options = {}) {
  return new NetworkManager(options);
}

class NetworkManager {
  constructor({ proxyForwardManager } = {}) {
    this.proxyForwardManager = proxyForwardManager;
    this.networks = new Map();
  }

  async upsert(rawNetwork = {}, instances = []) {
    const network = validateNetwork(rawNetwork);
    const existing = this.networks.get(network.id);
    const usedBy = inUseBy(network.id, instances);
    if (existing && usedBy.length && !sameNetworkConfig(existing, network)) {
      const error = new Error(`Network is in use: ${network.id}`);
      error.statusCode = 409;
      throw error;
    }

    if (network.proxy.mode === 'ssh-peer') {
      let forward;
      if (existing?.proxy?.mode === 'ssh-peer' && sameProxyConfig(existing.proxy, network.proxy)) {
        forward = {
          forwardId: existing.resolved.proxyForwardId,
          proxyServer: existing.resolved.proxyServer,
        };
      } else {
        if (existing?.resolved?.proxyForwardId) {
          this.proxyForwardManager?.delete?.(existing.resolved.proxyForwardId, instances);
        }
        forward = await this.proxyForwardManager?.create?.({
          name: network.id,
          remotePort: network.proxy.remotePort,
          localPort: network.proxy.localPort,
        });
      }
      if (!forward) {
        const error = new Error('ssh-peer networks require broker --ssh');
        error.statusCode = 400;
        throw error;
      }
      network.resolved = resolveNetwork({
        ...network,
        resolved: {
          ...network.resolved,
          proxyForwardId: forward.forwardId,
          proxyServer: forward.proxyServer,
        },
      });
    } else if (existing?.resolved?.proxyForwardId) {
      this.proxyForwardManager?.delete?.(existing.resolved.proxyForwardId, instances);
    }

    const saved = {
      ...existing,
      ...network,
      updatedAt: new Date().toISOString(),
    };
    if (!existing?.createdAt) saved.createdAt = saved.updatedAt;
    this.networks.set(saved.id, saved);
    return describeNetwork(saved);
  }

  list(instances = []) {
    return [...this.networks.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((network) => describeNetwork(network, inUseBy(network.id, instances)));
  }

  get(id, instances = []) {
    const network = this.networks.get(id);
    return network ? describeNetwork(network, inUseBy(id, instances)) : undefined;
  }

  resolve(id) {
    const network = this.networks.get(id);
    if (!network) {
      const error = new Error(`Unknown network: ${id}`);
      error.statusCode = 404;
      throw error;
    }
    return {
      networkId: network.id,
      ...network.resolved,
    };
  }

  check(id, instances = []) {
    const network = this.get(id, instances);
    if (!network) {
      const error = new Error(`Unknown network: ${id}`);
      error.statusCode = 404;
      throw error;
    }
    return {
      networkId: network.id,
      reachable: true,
      resolved: network.resolved,
      inUseBy: network.inUseBy,
    };
  }

  delete(id, instances = []) {
    const network = this.networks.get(id);
    if (!network) {
      const error = new Error(`Unknown network: ${id}`);
      error.statusCode = 404;
      throw error;
    }

    const usedBy = inUseBy(id, instances);
    if (usedBy.length) {
      const error = new Error(`Network is in use: ${id}`);
      error.statusCode = 409;
      throw error;
    }

    if (network.resolved?.proxyForwardId) {
      this.proxyForwardManager?.delete?.(network.resolved.proxyForwardId, instances);
    }

    this.networks.delete(id);
    return { deleted: true, networkId: id };
  }
}

function sameNetworkConfig(left, right) {
  return sameProxyConfig(left.proxy, right.proxy) &&
    JSON.stringify(left.browser ?? {}) === JSON.stringify(right.browser ?? {});
}

function sameProxyConfig(left, right) {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
}

function validateNetwork(rawNetwork) {
  const id = requiredString(rawNetwork.id, 'id');
  const proxy = validateProxy(rawNetwork.proxy);
  const browser = validateBrowser(rawNetwork.browser);
  const network = {
    id,
    kind: optionalString(rawNetwork.kind, 'kind'),
    name: optionalString(rawNetwork.name, 'name'),
    taskId: optionalString(rawNetwork.taskId, 'taskId'),
    owner: optionalString(rawNetwork.owner, 'owner'),
    purpose: optionalString(rawNetwork.purpose, 'purpose'),
    labels: optionalStringArray(rawNetwork.labels, 'labels'),
    proxy,
    browser,
  };
  return omitUndefined({
    ...network,
    resolved: resolveNetwork(network),
  });
}

function validateProxy(rawProxy) {
  if (!rawProxy || typeof rawProxy !== 'object' || Array.isArray(rawProxy)) {
    throwValidationError('proxy must be an object');
  }
  const mode = requiredString(rawProxy.mode, 'proxy.mode');
  if (mode === 'none') return { mode };
  if (mode === 'direct' || mode === 'broker-local') {
    return {
      mode,
      server: normalizeProxyServer(requiredString(rawProxy.server, 'proxy.server')),
    };
  }
  if (mode === 'ssh-peer') {
    return omitUndefined({
      mode,
      remotePort: normalizePort(rawProxy.remotePort, 'proxy.remotePort'),
      localPort: rawProxy.localPort === undefined
        ? undefined
        : normalizePort(rawProxy.localPort, 'proxy.localPort'),
    });
  }
  throwValidationError('proxy.mode must be one of: none, direct, broker-local, ssh-peer');
}

function validateBrowser(rawBrowser) {
  if (rawBrowser === undefined) return undefined;
  if (!rawBrowser || typeof rawBrowser !== 'object' || Array.isArray(rawBrowser)) {
    throwValidationError('browser must be an object');
  }
  return omitUndefined({
    ignoreSslErrors: rawBrowser.ignoreSslErrors === undefined
      ? undefined
      : Boolean(rawBrowser.ignoreSslErrors),
    proxyBypassList: optionalString(rawBrowser.proxyBypassList, 'browser.proxyBypassList'),
  });
}

function resolveNetwork(network) {
  return omitUndefined({
    proxyServer: network.proxy.server ?? network.resolved?.proxyServer,
    proxyForwardId: network.resolved?.proxyForwardId,
    ignoreSslErrors: network.browser?.ignoreSslErrors,
    proxyBypassList: network.browser?.proxyBypassList,
  });
}

function describeNetwork(network, usedBy = []) {
  return omitUndefined({
    id: network.id,
    kind: network.kind,
    name: network.name,
    taskId: network.taskId,
    owner: network.owner,
    purpose: network.purpose,
    labels: network.labels ? [...network.labels] : undefined,
    proxy: network.proxy ? { ...network.proxy } : undefined,
    browser: network.browser ? { ...network.browser } : undefined,
    resolved: network.resolved ? { ...network.resolved } : undefined,
    createdAt: network.createdAt,
    updatedAt: network.updatedAt,
    inUseBy: usedBy,
  });
}

function inUseBy(networkId, instances) {
  return instances
    .filter((instance) => instance.networkId === networkId)
    .map((instance) => instance.id);
}

function requiredString(value, name) {
  const string = optionalString(value, name);
  if (!string) throwValidationError(`${name} must be a non-empty string`);
  return string;
}

function optionalString(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throwValidationError(`${name} must be a string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalStringArray(value, name) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throwValidationError(`${name} must be an array`);
  return value.map((item, index) => requiredString(item, `${name}[${index}]`));
}

function normalizeProxyServer(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'socks5:') {
    throwValidationError('proxy.server must use http:// or socks5://');
  }
  return url.toString().replace(/\/$/, '');
}

function normalizePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throwValidationError(`${name} must be a TCP port between 1 and 65535`);
  }
  return port;
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

function throwValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}
