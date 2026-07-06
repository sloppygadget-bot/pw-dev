// @ts-check

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PW_DEV_SERVER_URL = 'http://127.0.0.1:9696';
const DEFAULT_PROXY_PORT_RANGE = '8888-8899';
const DEFAULT_UI_PORT_RANGE = '9800-9899';
const require = createRequire(import.meta.url);
const PROXY_MANAGER_PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_W2_STORAGE_ROOT = path.join(PROXY_MANAGER_PACKAGE_ROOT, '.runtime', 'whistle');

/**
 * Create a proxy manager runtime.
 *
 * The manager owns local Whistle child processes. App registrations and browser
 * sessions stay in `pw-dev/server`.
 *
 * @param {{
 *   serverUrl?: string,
 *   w2Command?: string,
 *   w2StorageRoot?: string,
 *   proxyPortRange?: string,
 *   uiPortRange?: string,
 *   portAvailable?: (port: number) => Promise<boolean>,
 *   spawnImpl?: typeof spawn,
 *   registryClient?: PwDevRegistryClient,
 *   quiet?: boolean,
 * }} options
 */
export function createProxyManager(options = {}) {
  const serverUrl = normalizeHttpUrl(options.serverUrl ?? DEFAULT_PW_DEV_SERVER_URL, 'serverUrl');
  const spawnImpl = options.spawnImpl ?? spawn;
  const registryClient = options.registryClient ?? createPwDevRegistryClient({ serverUrl });
  const whistle = resolveWhistleLauncher(options.w2Command);
  const w2StorageRoot = path.resolve(options.w2StorageRoot ?? DEFAULT_W2_STORAGE_ROOT);
  const proxyPortRange = parsePortRange(options.proxyPortRange ?? DEFAULT_PROXY_PORT_RANGE, 'proxyPortRange');
  const uiPortRange = parsePortRange(options.uiPortRange ?? DEFAULT_UI_PORT_RANGE, 'uiPortRange');
  const portAvailable = options.portAvailable ?? isPortAvailable;
  const quiet = Boolean(options.quiet);
  const proxies = new Map();

  return {
    serverUrl,
    async status() {
      return {
        ok: true,
        serverUrl,
        whistleCommand: whistle.command,
        whistleArgsPrefix: whistle.argsPrefix,
        w2StorageRoot,
        proxyPortRange,
        uiPortRange,
        proxies: listProcessRecords(proxies),
      };
    },
    async listProxies() {
      return { ok: true, proxies: listProcessRecords(proxies) };
    },
    async getProxy(id) {
      const proxy = proxies.get(id);
      if (!proxy) throw httpError(404, `Unknown managed proxy: ${id}`);
      return { ok: true, proxy: stripChild(proxy) };
    },
    async createProxy(input) {
      const request = validateCreateProxyRequest(input);
      if (proxies.has(request.id)) {
        throw httpError(409, `Managed proxy already exists: ${request.id}`);
      }

      const proxyPort = await selectPort({
        requested: request.proxyPort,
        range: proxyPortRange,
        usedPorts: runningPorts(proxies),
        portAvailable,
        name: 'proxyPort',
      });
      const uiPort = await selectPort({
        requested: request.uiPort,
        range: request.uiPortRange ?? uiPortRange,
        usedPorts: new Set([...runningPorts(proxies), proxyPort]),
        portAvailable,
        name: 'uiPort',
      });

      const storageDir = await createProxyStorageDir({ root: w2StorageRoot, id: request.id });
      const { rulesetFile, shadowRules } = await writeRuleset({ storageDir, ruleset: request.ruleset });
      const proxyUrl = `http://127.0.0.1:${proxyPort}`;
      const guiUrl = `http://127.0.0.1:${uiPort}`;
      const command = whistle.command;
      const args = [
        ...whistle.argsPrefix,
        'run',
        '-p',
        String(proxyPort),
        '--uiport',
        String(uiPort),
        '-S',
        storageDir,
        '-r',
        shadowRules,
      ];
      const child = spawnManagedProcess(spawnImpl, command, args, { quiet });
      const record = makeProcessRecord({
        id: request.id,
        kind: 'whistle',
        name: request.name,
        appId: request.appId,
        taskId: request.taskId,
        owner: request.owner,
        purpose: request.purpose,
        labels: request.labels,
        command,
        args,
        proxyPort,
        uiPort,
        proxyUrl,
        guiUrl,
        storageDir,
        rulesetFile,
        pid: child.pid,
      });
      proxies.set(request.id, record);
      child.once?.('error', (error) => {
        proxies.delete(request.id);
        void cleanupManagedProxy(record, quiet, registryClient);
        if (!quiet) console.error(`proxy process failed: ${request.id}: ${error.message}`);
      });
      child.once?.('exit', (code, signal) => {
        proxies.delete(request.id);
        void cleanupManagedProxy(record, quiet, registryClient);
        if (!quiet) console.error(`proxy process exited: ${request.id} code=${code} signal=${signal}`);
      });
      record.child = child;

      let app;
      try {
        await registryClient.updateProxy(omitUndefined({
          id: request.id,
          kind: 'whistle',
          name: request.name,
          appId: request.appId,
          taskId: request.taskId,
          owner: request.owner,
          purpose: request.purpose,
          labels: request.labels,
          proxyUrl,
          guiUrl,
          rulesetFile,
          managed: true,
        }));
        if (request.appId) {
          app = await registryClient.updateApp(request.appId, { proxyId: request.id });
        }
      } catch (error) {
        child.kill?.('SIGTERM');
        proxies.delete(request.id);
        await cleanupProcessRecord(record, quiet);
        throw error;
      }

      return { ok: true, proxy: stripChild(record), app };
    },
    async deleteProxy(id) {
      const proxy = proxies.get(id);
      if (!proxy) return { ok: true, proxy: { id, running: false }, alreadyStopped: true };
      proxy.child?.kill?.('SIGTERM');
      proxies.delete(id);
      await cleanupManagedProxy(proxy, true, registryClient);
      return { ok: true, proxy: { ...stripChild(proxy), running: false } };
    },
    async stopAll() {
      const stopped = await Promise.all(Array.from(proxies.keys()).map((id) => this.deleteProxy(id)));
      return { ok: true, proxies: stopped };
    },
  };
}

/**
 * Start the proxy manager HTTP API.
 *
 * @param {{ manager?: ReturnType<typeof createProxyManager>, host?: string, port?: number }} options
 */
export async function startProxyManagerServer(options = {}) {
  const manager = options.manager ?? createProxyManager();
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 18081;
  const server = createProxyManagerHttpServer({ manager });
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
 * @param {{ manager: ReturnType<typeof createProxyManager> }} options
 */
export function createProxyManagerHttpServer({ manager }) {
  return http.createServer(async (req, res) => {
    try {
      await handleProxyManagerRequest({ req, res, manager });
    } catch (error) {
      writeJson(res, error?.statusCode || 500, {
        ok: false,
        error: error?.message || 'Internal Server Error',
      });
    }
  });
}

async function handleProxyManagerRequest({ req, res, manager }) {
  const requestUrl = new URL(req.url || '/', 'http://local');
  const parts = requestUrl.pathname.split('/').filter(Boolean);
  if (parts[0] !== '_proxy') {
    writeJson(res, 404, { ok: false, error: 'Unknown proxy endpoint' });
    return;
  }

  if (req.method === 'GET' && parts.length === 2 && parts[1] === 'status') {
    writeJson(res, 200, await manager.status());
    return;
  }
  if (parts.length === 2 && parts[1] === 'proxies') {
    if (req.method === 'GET') {
      writeJson(res, 200, await manager.listProxies());
      return;
    }
    if (req.method === 'POST') {
      writeJson(res, 200, await manager.createProxy(await readJsonBody(req)));
      return;
    }
    writeMethodNotAllowed(res, 'GET, POST');
    return;
  }
  if (parts.length === 3 && parts[1] === 'proxies') {
    const id = decodeURIComponent(parts[2]);
    if (req.method === 'GET') {
      writeJson(res, 200, await manager.getProxy(id));
      return;
    }
    if (req.method === 'DELETE') {
      writeJson(res, 200, await manager.deleteProxy(id));
      return;
    }
    writeMethodNotAllowed(res, 'GET, DELETE');
    return;
  }
  if (req.method === 'POST' && parts.length === 4 && parts[1] === 'proxies' && parts[3] === 'stop') {
    writeJson(res, 200, await manager.deleteProxy(decodeURIComponent(parts[2])));
    return;
  }
  if (req.method === 'POST' && parts.length === 2 && parts[1] === 'stop-all') {
    writeJson(res, 200, await manager.stopAll());
    return;
  }

  writeJson(res, 404, { ok: false, error: 'Unknown proxy endpoint' });
}

export function createPwDevRegistryClient({ serverUrl = DEFAULT_PW_DEV_SERVER_URL } = {}) {
  const baseUrl = normalizeHttpUrl(serverUrl, 'serverUrl');
  return {
    async updateProxy(proxy) {
      const payload = await requestJson(new URL('/_pwdev/proxies', ensureTrailingSlash(baseUrl)), {
        method: 'POST',
        body: proxy,
      });
      return payload.proxy;
    },
    async updateApp(id, patch) {
      const payload = await requestJson(new URL(`/_pwdev/apps/${encodeURIComponent(id)}`, ensureTrailingSlash(baseUrl)), {
        method: 'PATCH',
        body: patch,
      });
      return payload.app;
    },
    async deleteProxy(id) {
      await requestJson(new URL(`/_pwdev/proxies/${encodeURIComponent(id)}`, ensureTrailingSlash(baseUrl)), {
        method: 'DELETE',
      });
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

function spawnManagedProcess(spawnImpl, command, args, { quiet }) {
  const child = spawnImpl(command, args, {
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

function resolveWhistleLauncher(w2Command) {
  if (w2Command) return { command: w2Command, argsPrefix: [] };
  return {
    command: process.execPath,
    argsPrefix: [require.resolve('whistle/bin/whistle.js')],
  };
}

function listProcessRecords(records) {
  return Array.from(records.values())
    .map(stripChild)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function makeProcessRecord({ id, kind, name, appId, taskId, owner, purpose, labels, command, args, proxyPort, uiPort, proxyUrl, guiUrl, storageDir, rulesetFile, pid }) {
  return {
    id,
    kind,
    name,
    appId,
    taskId,
    owner,
    purpose,
    labels,
    command,
    args,
    proxyPort,
    uiPort,
    proxyUrl,
    guiUrl,
    storageDir,
    rulesetFile,
    pid,
    running: true,
    startedAt: new Date().toISOString(),
  };
}

function stripChild(record) {
  const { child, storageCleanupPromise, ...publicRecord } = record;
  return publicRecord;
}

function validateCreateProxyRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw httpError(400, 'proxy create body must be an object');
  }
  const appId = optionalString(input.appId, 'appId');
  const id = optionalString(input.id, 'id') ?? (appId ? `${appId}-whistle` : undefined);
  if (!id) throw httpError(400, 'id or appId is required');
  if (input.ruleset === undefined) throw httpError(400, 'ruleset is required');
  return {
    id,
    appId,
    name: optionalString(input.name, 'name'),
    taskId: optionalString(input.taskId, 'taskId'),
    owner: optionalString(input.owner, 'owner'),
    purpose: optionalString(input.purpose, 'purpose'),
    labels: input.labels === undefined ? undefined : validateStringArray(input.labels, 'labels'),
    ruleset: input.ruleset,
    proxyPort: input.proxyPort === undefined ? undefined : parsePort(input.proxyPort, 'proxyPort'),
    uiPort: input.uiPort === undefined ? undefined : parsePort(input.uiPort, 'uiPort'),
    uiPortRange: input.uiPortRange === undefined ? undefined : parsePortRange(input.uiPortRange, 'uiPortRange'),
  };
}

function optionalString(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw httpError(400, `${name} must be a non-empty string`);
  }
  return value;
}

function validateStringArray(value, name) {
  if (!Array.isArray(value)) {
    throw httpError(400, `${name} must be an array of non-empty strings`);
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw httpError(400, `${name}[${index}] must be a non-empty string`);
    }
    return item;
  });
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

async function createProxyStorageDir({ root, id }) {
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, `${safeStoragePrefix(id)}-`));
}

async function writeRuleset({ storageDir, ruleset }) {
  const text = typeof ruleset === 'string' ? ruleset : JSON.stringify(ruleset, null, 2);
  const filename = typeof ruleset === 'string' ? 'ruleset.txt' : 'ruleset.json';
  const rulesetFile = path.join(storageDir, filename);
  await fs.writeFile(rulesetFile, text);
  return { rulesetFile, shadowRules: text };
}

function safeStoragePrefix(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_') || 'proxy';
}

async function cleanupProcessRecord(record, quiet = true) {
  if (!record.storageDir) return;
  if (!record.storageCleanupPromise) {
    record.storageCleanupPromise = fs.rm(record.storageDir, { recursive: true, force: true })
      .catch((error) => {
        if (!quiet) console.error(`proxy storage cleanup failed: ${record.storageDir}: ${error.message}`);
      });
  }
  await record.storageCleanupPromise;
}

async function cleanupManagedProxy(record, quiet, registryClient) {
  if (!record.managedCleanupPromise) {
    record.managedCleanupPromise = (async () => {
      await cleanupProcessRecord(record, quiet);
      try {
        await registryClient.deleteProxy?.(record.id);
        if (record.appId) {
          await registryClient.updateApp(record.appId, { proxyId: null });
        }
      } catch (error) {
        if (!quiet) console.error(`proxy registry cleanup failed: ${record.id}: ${error.message}`);
      }
    })();
  }
  await record.managedCleanupPromise;
}

async function selectPort({ requested, range, usedPorts, portAvailable, name }) {
  if (requested !== undefined) {
    if (usedPorts.has(requested) || !await portAvailable(requested)) {
      throw httpError(409, `${name} is unavailable: ${requested}`);
    }
    return requested;
  }
  for (let port = range.start; port <= range.end; port += 1) {
    if (usedPorts.has(port)) continue;
    if (await portAvailable(port)) return port;
  }
  throw httpError(409, `No available ${name} in range ${range.start}-${range.end}`);
}

function runningPorts(records) {
  const ports = new Set();
  for (const record of records.values()) {
    if (record.proxyPort) ports.add(record.proxyPort);
    if (record.uiPort) ports.add(record.uiPort);
  }
  return ports;
}

function parsePortRange(value, name) {
  const match = /^(\d+)-(\d+)$/.exec(String(value));
  if (!match) throw new Error(`${name} must look like 8888-8899`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!validPort(start) || !validPort(end) || start > end) {
    throw new Error(`${name} must be valid TCP ports with start <= end`);
  }
  return { start, end };
}

function parsePort(value, name) {
  const port = Number(value);
  if (!validPort(port)) throw httpError(400, `${name} must be a TCP port between 1 and 65535`);
  return port;
}

function validPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
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

function writeMethodNotAllowed(res, allow) {
  res.writeHead(405, { allow });
  res.end('Method Not Allowed');
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
 * @property {(proxy: Record<string, any>) => Promise<Record<string, any>>} updateProxy
 * @property {(id: string, patch: Record<string, any>) => Promise<Record<string, any>>} updateApp
 * @property {(id: string) => Promise<void>=} deleteProxy
 */
