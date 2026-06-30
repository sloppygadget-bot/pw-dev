// @ts-check

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const DEFAULT_PW_DEV_SERVER_URL = 'http://127.0.0.1:9696';
const DEFAULT_W2_COMMAND = 'w2';
const DEFAULT_PROXY_PORT_RANGE = '8888-8899';

/**
 * Create a w2mgr runtime.
 *
 * The manager is intentionally separate from `pw-dev/server`: it owns local
 * app/proxy child processes while the server remains the registry and proxying
 * control plane.
 *
 * @param {{
 *   serverUrl?: string,
 *   w2Command?: string,
 *   proxyPortRange?: string,
 *   portAvailable?: (port: number) => Promise<boolean>,
 *   spawnImpl?: typeof spawn,
 *   registryClient?: PwDevRegistryClient,
 *   quiet?: boolean,
 * }} options
 */
export function createW2Mgr(options = {}) {
  const serverUrl = normalizeHttpUrl(options.serverUrl ?? DEFAULT_PW_DEV_SERVER_URL, 'serverUrl');
  const spawnImpl = options.spawnImpl ?? spawn;
  const registryClient = options.registryClient ?? createPwDevRegistryClient({ serverUrl });
  const w2Command = options.w2Command ?? DEFAULT_W2_COMMAND;
  const proxyPortRange = parsePortRange(options.proxyPortRange ?? DEFAULT_PROXY_PORT_RANGE);
  const portAvailable = options.portAvailable ?? isPortAvailable;
  const quiet = Boolean(options.quiet);
  const apps = new Map();
  const proxies = new Map();

  return {
    serverUrl,
    async status() {
      return {
        ok: true,
        serverUrl,
        proxyPortRange,
        apps: listProcessRecords(apps),
        proxies: listProcessRecords(proxies),
      };
    },
    async sync({ startApps = false, startProxies = false } = {}) {
      const [appList, proxyList] = await Promise.all([
        registryClient.listApps(),
        registryClient.listProxies(),
      ]);
      const result = { ok: true, apps: appList, proxies: proxyList };
      if (startApps) result.startedApps = await startMany(appList, (app) => this.startApp(app.id));
      if (startProxies) result.startedProxies = await startMany(proxyList, (proxy) => this.startProxy(proxy.id));
      return result;
    },
    async startApp(id) {
      if (apps.has(id)) return { ok: true, app: stripChild(apps.get(id)), alreadyRunning: true };
      const app = await registryClient.getApp(id);
      if (!app?.devserver?.command) {
        throw httpError(400, `App has no devserver command: ${id}`);
      }
      const command = app.devserver.command;
      const args = app.devserver.args ?? [];
      const cwd = app.devserver.cwd ?? app.worktree ?? process.cwd();
      const child = spawnManagedProcess(spawnImpl, command, args, {
        cwd,
        env: { ...process.env, ...(app.devserver.env ?? {}) },
        quiet,
      });
      const record = makeProcessRecord({
        id,
        kind: 'app',
        command,
        args,
        cwd: path.resolve(cwd),
        pid: child.pid,
      });
      apps.set(id, record);
      child.once?.('error', (error) => {
        apps.delete(id);
        if (!quiet) console.error(`app process failed: ${id}: ${error.message}`);
      });
      child.once?.('exit', (code, signal) => {
        apps.delete(id);
        if (!quiet) console.error(`app process exited: ${id} code=${code} signal=${signal}`);
      });
      record.child = child;
      return { ok: true, app: stripChild(record) };
    },
    async stopApp(id) {
      return stopProcess(apps, id, 'app');
    },
    async startProxy(id) {
      if (proxies.has(id)) return { ok: true, proxy: stripChild(proxies.get(id)), alreadyRunning: true };
      const proxy = await registryClient.getProxy(id);
      if (!proxy?.proxyUrl) {
        throw httpError(400, `Proxy has no proxyUrl to run locally: ${id}`);
      }
      const port = await allocateProxyPort({
        proxyUrl: proxy.proxyUrl,
        range: proxyPortRange,
        runningProxies: proxies,
        portAvailable,
      });
      const proxyUrl = rewriteProxyUrlPort(proxy.proxyUrl, port);
      if (proxyUrl !== proxy.proxyUrl && registryClient.updateProxy) {
        await registryClient.updateProxy({ ...proxy, proxyUrl });
      }
      const command = w2Command;
      const args = ['run', '-p', String(port)];
      const child = spawnManagedProcess(spawnImpl, command, args, { quiet });
      const record = makeProcessRecord({
        id,
        kind: 'proxy',
        command,
        args,
        port,
        proxyUrl,
        pid: child.pid,
      });
      proxies.set(id, record);
      child.once?.('error', (error) => {
        proxies.delete(id);
        if (!quiet) console.error(`proxy process failed: ${id}: ${error.message}`);
      });
      child.once?.('exit', (code, signal) => {
        proxies.delete(id);
        if (!quiet) console.error(`proxy process exited: ${id} code=${code} signal=${signal}`);
      });
      record.child = child;
      return { ok: true, proxy: stripChild(record) };
    },
    async stopProxy(id) {
      return stopProcess(proxies, id, 'proxy');
    },
    async startAll() {
      const [appList, proxyList] = await Promise.all([
        registryClient.listApps(),
        registryClient.listProxies(),
      ]);
      return {
        ok: true,
        apps: await startMany(appList.filter((app) => app.devserver?.command), (app) => this.startApp(app.id)),
        proxies: await startMany(proxyList.filter((proxy) => proxy.proxyUrl), (proxy) => this.startProxy(proxy.id)),
      };
    },
    async stopAll() {
      const stoppedApps = await Promise.all(Array.from(apps.keys()).map((id) => this.stopApp(id)));
      const stoppedProxies = await Promise.all(Array.from(proxies.keys()).map((id) => this.stopProxy(id)));
      return { ok: true, apps: stoppedApps, proxies: stoppedProxies };
    },
  };
}

/**
 * Start the w2mgr HTTP API.
 *
 * @param {{ manager?: ReturnType<typeof createW2Mgr>, host?: string, port?: number }} options
 */
export async function startW2MgrServer(options = {}) {
  const manager = options.manager ?? createW2Mgr();
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 18081;
  const server = createW2MgrHttpServer({ manager });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    origin: `http://${host}:${actualPort}`,
    server,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

/**
 * @param {{ manager: ReturnType<typeof createW2Mgr> }} options
 */
export function createW2MgrHttpServer({ manager }) {
  return http.createServer(async (req, res) => {
    try {
      await handleW2MgrRequest({ req, res, manager });
    } catch (error) {
      writeJson(res, error?.statusCode || 500, {
        ok: false,
        error: error?.message || 'Internal Server Error',
      });
    }
  });
}

async function handleW2MgrRequest({ req, res, manager }) {
  const requestUrl = new URL(req.url || '/', 'http://local');
  const parts = requestUrl.pathname.split('/').filter(Boolean);
  if (parts[0] !== '_w2mgr') {
    writeJson(res, 404, { ok: false, error: 'Unknown w2mgr endpoint' });
    return;
  }

  if (req.method === 'GET' && parts.length === 2 && parts[1] === 'status') {
    writeJson(res, 200, await manager.status());
    return;
  }
  if (req.method === 'POST' && parts.length === 2 && parts[1] === 'sync') {
    writeJson(res, 200, await manager.sync(await readJsonBody(req)));
    return;
  }
  if (req.method === 'POST' && parts.length === 2 && parts[1] === 'start-all') {
    writeJson(res, 200, await manager.startAll());
    return;
  }
  if (req.method === 'POST' && parts.length === 2 && parts[1] === 'stop-all') {
    writeJson(res, 200, await manager.stopAll());
    return;
  }
  if (req.method === 'POST' && parts.length === 4 && parts[1] === 'apps') {
    const id = decodeURIComponent(parts[2]);
    if (parts[3] === 'start') writeJson(res, 200, await manager.startApp(id));
    else if (parts[3] === 'stop') writeJson(res, 200, await manager.stopApp(id));
    else writeJson(res, 404, { ok: false, error: 'Unknown app action' });
    return;
  }
  if (req.method === 'POST' && parts.length === 4 && parts[1] === 'proxies') {
    const id = decodeURIComponent(parts[2]);
    if (parts[3] === 'start') writeJson(res, 200, await manager.startProxy(id));
    else if (parts[3] === 'stop') writeJson(res, 200, await manager.stopProxy(id));
    else writeJson(res, 404, { ok: false, error: 'Unknown proxy action' });
    return;
  }

  writeJson(res, 404, { ok: false, error: 'Unknown w2mgr endpoint' });
}

export function createPwDevRegistryClient({ serverUrl = DEFAULT_PW_DEV_SERVER_URL } = {}) {
  const baseUrl = normalizeHttpUrl(serverUrl, 'serverUrl');
  return {
    async listApps() {
      const payload = await requestJson(new URL('/_pwdev/apps', ensureTrailingSlash(baseUrl)));
      return payload.apps ?? [];
    },
    async getApp(id) {
      const payload = await requestJson(new URL(`/_pwdev/apps/${encodeURIComponent(id)}`, ensureTrailingSlash(baseUrl)));
      return payload.app;
    },
    async listProxies() {
      const payload = await requestJson(new URL('/_pwdev/proxies', ensureTrailingSlash(baseUrl)));
      return payload.proxies ?? [];
    },
    async getProxy(id) {
      const payload = await requestJson(new URL(`/_pwdev/proxies/${encodeURIComponent(id)}`, ensureTrailingSlash(baseUrl)));
      return payload.proxy;
    },
    async updateProxy(proxy) {
      const payload = await requestJson(new URL('/_pwdev/proxies', ensureTrailingSlash(baseUrl)), {
        method: 'POST',
        body: proxy,
      });
      return payload.proxy;
    },
  };
}

function requestJson(url, { method = 'GET', body } = {}) {
  const requestBody = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method,
      headers: requestBody ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(requestBody),
      } : undefined,
    }, (response) => {
      let responseText = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        responseText += chunk;
      });
      response.on('end', () => {
        let payload;
        try {
          payload = responseText ? JSON.parse(responseText) : {};
        } catch {
          payload = { ok: false, error: responseText };
        }
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          reject(httpError(response.statusCode ?? 500, payload.error || `Request failed: ${response.statusCode}`));
          return;
        }
        resolve(payload);
      });
    });
    request.once('error', reject);
    request.end(requestBody);
  });
}

function spawnManagedProcess(spawnImpl, command, args, { cwd, env, quiet }) {
  const child = spawnImpl(command, args, {
    cwd,
    env,
    stdio: quiet ? 'ignore' : 'inherit',
  });
  if (!child || typeof child !== 'object') {
    throw httpError(500, `Failed to start process: ${command}`);
  }
  child.once?.('error', (error) => {
    if (!quiet) console.error(`process start failed: ${command}: ${error.message}`);
  });
  return child;
}

async function stopProcess(records, id, kind) {
  const record = records.get(id);
  if (!record) return { ok: true, [kind]: { id, running: false }, alreadyStopped: true };
  record.child?.kill?.('SIGTERM');
  records.delete(id);
  return { ok: true, [kind]: { ...stripChild(record), running: false } };
}

async function startMany(items, start) {
  const results = [];
  for (const item of items) {
    results.push(await start(item));
  }
  return results;
}

function listProcessRecords(records) {
  return Array.from(records.values())
    .map(stripChild)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function makeProcessRecord({ id, kind, command, args, cwd, port, proxyUrl, pid }) {
  return {
    id,
    kind,
    command,
    args,
    cwd,
    port,
    proxyUrl,
    pid,
    running: true,
    startedAt: new Date().toISOString(),
  };
}

function stripChild(record) {
  const { child, ...publicRecord } = record;
  return publicRecord;
}

async function allocateProxyPort({ proxyUrl, range, runningProxies, portAvailable }) {
  const preferred = proxyPort(proxyUrl);
  if (portInRange(preferred, range) && !isManagedProxyPortUsed(runningProxies, preferred) && await portAvailable(preferred)) {
    return preferred;
  }
  for (let port = range.start; port <= range.end; port += 1) {
    if (isManagedProxyPortUsed(runningProxies, port)) continue;
    if (await portAvailable(port)) return port;
  }
  throw httpError(409, `No available Whistle proxy port in range ${range.start}-${range.end}`);
}

function isManagedProxyPortUsed(runningProxies, port) {
  return Array.from(runningProxies.values()).some((record) => record.port === port);
}

function parsePortRange(value) {
  const match = /^(\d+)-(\d+)$/.exec(String(value));
  if (!match) throw new Error('proxyPortRange must look like 8888-8899');
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!validPort(start) || !validPort(end) || start > end) {
    throw new Error('proxyPortRange must be valid TCP ports with start <= end');
  }
  return { start, end };
}

function portInRange(port, range) {
  return port >= range.start && port <= range.end;
}

function validPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function proxyPort(proxyUrl) {
  const url = new URL(proxyUrl);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!validPort(port)) throw httpError(400, `Invalid proxy port: ${proxyUrl}`);
  return port;
}

function rewriteProxyUrlPort(proxyUrl, port) {
  const url = new URL(proxyUrl);
  url.port = String(port);
  return url.toString().replace(/\/$/, '');
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw httpError(400, 'Request body must be valid JSON');
  }
}

function writeJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function normalizeHttpUrl(value, name) {
  const url = new URL(value);
  if (url.protocol !== 'http:') throw new Error(`${name} must use http://`);
  return url.toString().replace(/\/$/, '');
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * @typedef {object} PwDevRegistryClient
 * @property {() => Promise<Record<string, any>[]>} listApps
 * @property {(id: string) => Promise<Record<string, any>>} getApp
 * @property {() => Promise<Record<string, any>[]>} listProxies
 * @property {(id: string) => Promise<Record<string, any>>} getProxy
 * @property {(proxy: Record<string, any>) => Promise<Record<string, any>>=} updateProxy
 */
