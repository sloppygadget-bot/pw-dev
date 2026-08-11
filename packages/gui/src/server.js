// @ts-check

import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { BrowserMonitorHub } from './monitor.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9797;
const DEFAULT_PWDEV_URL = 'http://127.0.0.1:9696';
const DEFAULT_BROKER_URL = 'http://127.0.0.1:18080';
const DEFAULT_BROKER_SCAN_HOST = '127.0.0.1';
const DEFAULT_BROKER_SCAN_START_PORT = 18080;
const DEFAULT_BROKER_SCAN_END_PORT = 18089;
const DEFAULT_BROKER_SCAN_TIMEOUT_MS = 350;
const DEFAULT_PROXY_MANAGER_URL = 'http://127.0.0.1:9697';
const PUBLIC_DIR = path.resolve(new URL('../public', import.meta.url).pathname);
const require = createRequire(import.meta.url);
const SWAGGER_UI_DIR = path.dirname(require.resolve('swagger-ui-dist/swagger-ui.css'));
const SWAGGER_UI_ASSETS = new Set(['swagger-ui.css', 'swagger-ui-bundle.js', 'swagger-ui-standalone-preset.js']);

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
]);

export async function startPwDevGuiServer(options = {}) {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const pwDevUrl = normalizeHttpUrl(options.pwDevUrl ?? DEFAULT_PWDEV_URL, 'pwDevUrl');
  const brokerUrl = normalizeHttpUrl(options.brokerUrl ?? DEFAULT_BROKER_URL, 'brokerUrl');
  const proxyManagerUrl = normalizeHttpUrl(options.proxyManagerUrl ?? DEFAULT_PROXY_MANAGER_URL, 'proxyManagerUrl');
  const brokerDiscovery = normalizeBrokerDiscovery(options.brokerDiscovery, options.brokerDiscoveryPorts);
  const monitorHub = new BrowserMonitorHub({ pwDevUrl });

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || '/', 'http://local');
      if (requestUrl.pathname === '/api/config') {
        writeJson(res, 200, { ok: true, pwDevUrl, brokerUrl, proxyManagerUrl });
        return;
      }
      if (requestUrl.pathname === '/api/healthz') {
        writeJson(res, 200, { ok: true });
        return;
      }
      if (requestUrl.pathname === '/api/snapshot') {
        writeJson(res, 200, await collectSnapshot({ pwDevUrl, brokerUrl, proxyManagerUrl, brokerDiscovery }));
        return;
      }
      const monitorEvents = /^\/api\/monitor\/([^/]+)\/events$/.exec(requestUrl.pathname);
      if (monitorEvents) {
        await monitorHub.stream(decodePathSegment(monitorEvents[1]), req, res);
        return;
      }
      const monitorAction = /^\/api\/monitor\/([^/]+)\/action$/.exec(requestUrl.pathname);
      if (monitorAction) {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: 'monitor actions require POST' });
          return;
        }
        const payload = await readJsonRequest(req);
        writeJson(res, 200, await monitorHub.action(decodePathSegment(monitorAction[1]), payload));
        return;
      }
      const monitorPage = /^\/monitor\/([^/]+)$/.exec(requestUrl.pathname);
      if (monitorPage) {
        await serveStaticFile({ req, res, filePath: path.join(PUBLIC_DIR, 'monitor.html'), contentType: 'text/html; charset=utf-8' });
        return;
      }
      if (requestUrl.pathname === '/api-docs') {
        res.writeHead(302, { location: '/api-docs/' });
        res.end();
        return;
      }
      if (requestUrl.pathname === '/api-docs/') {
        await serveStaticFile({ req, res, filePath: path.join(PUBLIC_DIR, 'api-docs.html'), contentType: 'text/html; charset=utf-8' });
        return;
      }
      if (requestUrl.pathname.startsWith('/api-docs/swagger-ui/')) {
        const asset = path.basename(requestUrl.pathname);
        if (!SWAGGER_UI_ASSETS.has(asset)) {
          writeText(res, 404, 'text/plain; charset=utf-8', 'Not Found');
          return;
        }
        await serveStaticFile({ req, res, filePath: path.join(SWAGGER_UI_DIR, asset), contentType: MIME_TYPES.get(path.extname(asset)) || 'application/octet-stream' });
        return;
      }
      if (requestUrl.pathname.startsWith('/api/network-check/')) {
        await proxyNetworkCheck({ req, res, requestUrl, pwDevUrl });
        return;
      }
      if (requestUrl.pathname.startsWith('/proxy/')) {
        await proxyWhistleGui({ req, res, requestUrl, pwDevUrl });
        return;
      }
      if (requestUrl.pathname === '/api/pwdev' || requestUrl.pathname.startsWith('/api/pwdev/')) {
        await proxyPwDevRequest({ req, res, requestUrl, pwDevUrl });
        return;
      }
      if (requestUrl.pathname === '/_pwdev' || requestUrl.pathname.startsWith('/_pwdev/')) {
        await proxyPwDevRequest({ req, res, requestUrl, pwDevUrl });
        return;
      }
      await serveStatic({ req, res, root: PUBLIC_DIR });
    } catch (error) {
      writeJson(res, error?.statusCode || 500, {
        ok: false,
        error: error?.message || 'Internal Server Error',
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const origin = `http://${host}:${actualPort}`;
  return {
    origin,
    pwDevUrl,
    brokerUrl,
    proxyManagerUrl,
    server,
    close: async () => {
      await monitorHub.close();
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

async function collectSnapshot({ pwDevUrl, brokerUrl, proxyManagerUrl, brokerDiscovery }) {
  const [
    serverStatus,
    apps,
    browserConfigs,
    sessions,
    browsers,
    serverProxies,
    serverNetworks,
    brokerStatus,
    brokerNetworks,
    brokerForwards,
    proxyStatus,
  ] = await Promise.all([
    fetchJsonFrom(`${pwDevUrl}/_pwdev/status`),
    fetchJsonFrom(`${pwDevUrl}/_pwdev/apps`),
    fetchJsonFrom(`${pwDevUrl}/_pwdev/browser-configs`),
    fetchJsonFrom(`${pwDevUrl}/_pwdev/sessions`),
    fetchJsonFrom(`${pwDevUrl}/_pwdev/browsers`),
    fetchJsonFrom(`${pwDevUrl}/_pwdev/proxies`),
    fetchJsonFrom(`${pwDevUrl}/_pwdev/networks`),
    fetchJsonFrom(`${brokerUrl}/_broker/status`),
    fetchJsonFrom(`${brokerUrl}/_broker/networks`),
    fetchJsonFrom(`${brokerUrl}/_broker/proxy-forwards`),
    fetchJsonFrom(`${proxyManagerUrl}/_proxy/status`),
  ]);
  const brokerUrls = discoverBrokerUrls({ brokerUrl, serverStatus, browserConfigs, sessions });
  const discoveredBrokers = brokerDiscovery.enabled
    ? await scanLocalBrokers({ ...brokerDiscovery, knownUrls: brokerUrls })
    : [];
  const brokerEntries = [
    ...brokerUrls.map((url) => ({ url })),
    ...discoveredBrokers,
  ];
  const brokers = await Promise.all(brokerEntries.map((entry) => collectBrokerSnapshot(entry.url, {
    initialStatus: entry.status,
    discovered: entry.discovered,
  })));
  const primaryBroker = brokers.find((broker) => broker.url === brokerUrl) ?? brokers[0];
  const proxyStatuses = await collectProxyStatuses(serverProxies.body?.proxies, proxyStatus.body?.proxies);

  return {
    ok: true,
    urls: { pwDevUrl, brokerUrl, proxyManagerUrl },
    collectedAt: new Date().toISOString(),
    server: {
      status: serverStatus,
      apps,
      browserConfigs,
      sessions,
      browsers,
      proxies: serverProxies,
      proxyStatuses,
      networks: serverNetworks,
    },
    broker: {
      status: primaryBroker?.status ?? brokerStatus,
      networks: primaryBroker?.networks ?? brokerNetworks,
      proxyForwards: primaryBroker?.proxyForwards ?? brokerForwards,
    },
    brokers,
    proxyManager: {
      status: proxyStatus,
    },
  };
}

function normalizeBrokerDiscovery(raw, ports) {
  if (raw === false) return { enabled: false };
  const configuredPorts = Array.isArray(ports) ? ports : undefined;
  const scanPorts = configuredPorts ?? Array.from(
    { length: DEFAULT_BROKER_SCAN_END_PORT - DEFAULT_BROKER_SCAN_START_PORT + 1 },
    (_, index) => DEFAULT_BROKER_SCAN_START_PORT + index,
  );
  return {
    enabled: raw?.enabled !== false,
    host: raw?.host ?? DEFAULT_BROKER_SCAN_HOST,
    ports: scanPorts.filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535),
    timeoutMs: raw?.timeoutMs ?? DEFAULT_BROKER_SCAN_TIMEOUT_MS,
  };
}

function discoverBrokerUrls({ brokerUrl, serverStatus, browserConfigs, sessions }) {
  const urls = new Set();
  const add = (value) => {
    if (!value) return;
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') urls.add(url.origin);
    } catch {
      // Ignore stale or malformed session overrides.
    }
  };

  add(brokerUrl);
  add(serverStatus.body?.broker?.url);
  for (const session of sessions.body?.sessions ?? []) add(session.brokerUrl);
  for (const browserConfig of browserConfigs.body?.browserConfigs ?? []) add(browserConfig.brokerUrl);
  return [...urls];
}

async function collectBrokerSnapshot(url, { initialStatus, discovered = false } = {}) {
  const [status, networks, proxyForwards] = await Promise.all([
    initialStatus ?? fetchJsonFrom(`${url}/_broker/status`),
    fetchJsonFrom(`${url}/_broker/networks`),
    fetchJsonFrom(`${url}/_broker/proxy-forwards`),
  ]);
  return { url, status, networks, proxyForwards, discovered };
}

async function scanLocalBrokers({ host, ports, timeoutMs, knownUrls }) {
  const known = new Set(knownUrls);
  const candidates = await Promise.all(ports.map(async (port) => {
    const url = `http://${host}:${port}`;
    const status = await fetchJsonFrom(`${url}/_broker/status`, { timeoutMs });
    if (!status.ok || status.body?.ok !== true || known.has(url)) return undefined;
    return { url, status, discovered: true };
  }));
  return candidates.filter(Boolean);
}

async function collectProxyStatuses(proxies, managedProxies) {
  const managedById = new Map((Array.isArray(managedProxies) ? managedProxies : []).map((proxy) => [proxy.id, proxy]));
  return Promise.all((Array.isArray(proxies) ? proxies : []).map(async (proxy) => {
    const managed = managedById.get(proxy.id);
    if (managed) return { id: proxy.id, running: Boolean(managed.running) };
    const port = localPortFromUrl(proxy.proxyUrl);
    return { id: proxy.id, running: port ? await probeLocalPort(port) : undefined };
  }));
}

function localPortFromUrl(rawUrl) {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return undefined;
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
  } catch {
    return undefined;
  }
}

function probeLocalPort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (running) => {
      socket.destroy();
      resolve(running);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(750, () => finish(false));
  });
}

function fetchJsonFrom(rawUrl, { timeoutMs = 1500 } = {}) {
  const url = new URL(rawUrl);
  return new Promise((resolve) => {
    const request = http.request(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        text += chunk;
      });
      response.on('end', () => {
        let body;
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          body = { ok: false, error: text };
        }
        resolve({
          ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300 && body?.ok !== false,
          statusCode: response.statusCode ?? 0,
          url: rawUrl,
          body,
          error: body?.error,
        });
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('request timed out'));
    });
    request.once('error', (error) => {
      resolve({
        ok: false,
        statusCode: 0,
        url: rawUrl,
        body: undefined,
        error: error.message,
      });
    });
    request.end();
  });
}

async function proxyPwDevRequest({ req, res, requestUrl, pwDevUrl }) {
  const isGuiApiPath = requestUrl.pathname === '/api/pwdev' || requestUrl.pathname.startsWith('/api/pwdev/');
  const suffix = isGuiApiPath ? requestUrl.pathname.slice('/api/pwdev'.length) : requestUrl.pathname;
  const upstreamPath = isGuiApiPath ? `/_pwdev${suffix || ''}` : suffix;
  const assetMutation = isGuiApiPath && (
    upstreamPath === '/_pwdev/browser-configs' || upstreamPath.startsWith('/_pwdev/browser-configs/') ||
    upstreamPath === '/_pwdev/browsers' || upstreamPath.startsWith('/_pwdev/browsers/') ||
    upstreamPath === '/_pwdev/proxies' || upstreamPath.startsWith('/_pwdev/proxies/')
  ) && ['POST', 'DELETE'].includes(req.method);
  if (req.method !== 'GET' && req.method !== 'HEAD' && !assetMutation) {
    writeJson(res, 405, { ok: false, error: 'pw-dev GUI is read-only' });
    return;
  }

  const upstreamUrl = new URL(`${upstreamPath}${requestUrl.search}`, ensureTrailingSlash(pwDevUrl));
  const upstream = http.request(upstreamUrl, {
    method: req.method,
    headers: {
      accept: req.headers.accept || 'application/json',
      ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
      ...(req.headers['content-length'] ? { 'content-length': req.headers['content-length'] } : {}),
    },
  }, (response) => {
    const headers = {
      ...response.headers,
      'cache-control': 'no-store',
    };
    res.writeHead(response.statusCode ?? 502, headers);
    response.pipe(res);
  });

  upstream.once('error', (error) => {
    writeJson(res, 502, {
      ok: false,
      error: `pw-dev server is unreachable at ${pwDevUrl}: ${error.message}`,
    });
  });
  if (assetMutation) req.pipe(upstream);
  else upstream.end();
}

async function serveStaticFile({ req, res, filePath, contentType }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }
  try {
    const body = req.method === 'HEAD' ? undefined : await fs.readFile(filePath);
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    writeText(res, 404, 'text/plain; charset=utf-8', 'Not Found');
  }
}

async function proxyNetworkCheck({ req, res, requestUrl, pwDevUrl }) {
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: 'network check requires POST' });
    return;
  }
  const networkId = requestUrl.pathname.slice('/api/network-check/'.length);
  const upstreamUrl = new URL(
    `/_pwdev/networks/${encodeURIComponent(decodeURIComponent(networkId))}/check`,
    ensureTrailingSlash(pwDevUrl)
  );
  const upstream = http.request(upstreamUrl, {
    method: 'POST',
    headers: { accept: 'application/json' },
  }, (response) => {
    res.writeHead(response.statusCode ?? 502, {
      ...response.headers,
      'cache-control': 'no-store',
    });
    response.pipe(res);
  });
  upstream.once('error', (error) => writeJson(res, 502, {
    ok: false,
    error: `pw-dev server is unreachable at ${pwDevUrl}: ${error.message}`,
  }));
  upstream.end();
}

async function proxyWhistleGui({ req, res, requestUrl, pwDevUrl }) {
  const match = /^\/proxy\/([^/]+)\/gui(\/.*)?$/.exec(requestUrl.pathname);
  if (!match) {
    writeText(res, 404, 'text/plain; charset=utf-8', 'Not Found');
    return;
  }
  if (!match[2]) {
    const location = `${requestUrl.pathname}/`;
    res.writeHead(302, { location });
    res.end();
    return;
  }

  let proxyId;
  try {
    proxyId = decodeURIComponent(match[1]);
  } catch {
    writeText(res, 400, 'text/plain; charset=utf-8', 'Invalid proxy id');
    return;
  }
  const record = await fetchJsonFrom(`${pwDevUrl}/_pwdev/proxies/${encodeURIComponent(proxyId)}`);
  const guiUrl = record.body?.proxy?.guiUrl;
  if (!record.ok || !guiUrl) {
    writeJson(res, record.statusCode === 404 ? 404 : 502, {
      ok: false,
      error: record.error || `Proxy GUI is unavailable for ${proxyId}`,
    });
    return;
  }

  const upstreamUrl = new URL(match[2] || '/', ensureTrailingSlash(guiUrl));
  upstreamUrl.search = requestUrl.search;
  const headers = { ...req.headers };
  delete headers.connection;
  delete headers.host;
  const upstream = http.request(upstreamUrl, {
    method: req.method,
    headers: {
      ...headers,
      host: upstreamUrl.host,
      'accept-encoding': 'identity',
    },
  }, (response) => {
    const headers = { ...response.headers, 'cache-control': 'no-store' };
    res.writeHead(response.statusCode ?? 502, headers);
    response.pipe(res);
  });
  upstream.once('error', (error) => writeJson(res, 502, {
    ok: false,
    error: `Whistle GUI is unreachable at ${guiUrl}: ${error.message}`,
  }));
  req.pipe(upstream);
}

async function serveStatic({ req, res, root }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  const requestUrl = new URL(req.url || '/', 'http://local');
  const filePath = resolveStaticPath(root, requestUrl.pathname);
  if (!filePath) {
    writeText(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
    return;
  }
  const resolved = await resolveFile(filePath);
  if (!resolved) {
    writeText(res, 404, 'text/plain; charset=utf-8', 'Not Found');
    return;
  }
  const body = req.method === 'HEAD' ? undefined : await fs.readFile(resolved.path);
  res.writeHead(200, {
    'content-type': MIME_TYPES.get(path.extname(resolved.path).toLowerCase()) || 'application/octet-stream',
    'content-length': resolved.size,
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function resolveStaticPath(root, urlPathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPathname);
  } catch {
    return undefined;
  }
  const pathname = decoded === '/' ? '/index.html' : decoded;
  const absolute = path.resolve(root, `.${path.sep}${path.normalize(pathname)}`);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return absolute;
}

async function resolveFile(filePath) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return undefined;
  }
  if (stat.isDirectory()) return resolveFile(path.join(filePath, 'index.html'));
  if (!stat.isFile()) return undefined;
  return { path: filePath, size: stat.size };
}

function normalizeHttpUrl(value, name) {
  const url = new URL(value);
  if (url.protocol !== 'http:') {
    throw new Error(`${name} must use http://`);
  }
  return url.toString().replace(/\/$/, '');
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    const error = new Error('Invalid monitor identifier');
    error.statusCode = 400;
    throw error;
  }
}

function readJsonRequest(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        const error = new Error('Request body must be valid JSON');
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function writeJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function writeText(res, statusCode, contentType, text) {
  const body = Buffer.from(text);
  res.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}
