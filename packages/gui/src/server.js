// @ts-check

import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9797;
const DEFAULT_PWDEV_URL = 'http://127.0.0.1:9696';
const DEFAULT_BROKER_URL = 'http://127.0.0.1:18080';
const DEFAULT_PROXY_MANAGER_URL = 'http://127.0.0.1:18081';
const PUBLIC_DIR = path.resolve(new URL('../public', import.meta.url).pathname);

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
        writeJson(res, 200, await collectSnapshot({ pwDevUrl, brokerUrl, proxyManagerUrl }));
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
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function collectSnapshot({ pwDevUrl, brokerUrl, proxyManagerUrl }) {
  const [
    serverStatus,
    apps,
    sessions,
    serverProxies,
    serverNetworks,
    brokerStatus,
    brokerNetworks,
    brokerForwards,
    proxyStatus,
  ] = await Promise.all([
    fetchJsonFrom(`${pwDevUrl}/_pwdev/status`),
    fetchJsonFrom(`${pwDevUrl}/_pwdev/apps`),
    fetchJsonFrom(`${pwDevUrl}/_pwdev/sessions`),
    fetchJsonFrom(`${pwDevUrl}/_pwdev/proxies`),
    fetchJsonFrom(`${pwDevUrl}/_pwdev/networks`),
    fetchJsonFrom(`${brokerUrl}/_broker/status`),
    fetchJsonFrom(`${brokerUrl}/_broker/networks`),
    fetchJsonFrom(`${brokerUrl}/_broker/proxy-forwards`),
    fetchJsonFrom(`${proxyManagerUrl}/_proxy/status`),
  ]);
  const [appServerStatuses, proxyStatuses] = await Promise.all([
    collectAppServerStatuses(apps.body?.apps),
    collectProxyStatuses(serverProxies.body?.proxies, proxyStatus.body?.proxies),
  ]);

  return {
    ok: true,
    urls: { pwDevUrl, brokerUrl, proxyManagerUrl },
    collectedAt: new Date().toISOString(),
    server: {
      status: serverStatus,
      apps,
      sessions,
      appServerStatuses,
      proxies: serverProxies,
      proxyStatuses,
      networks: serverNetworks,
    },
    broker: {
      status: brokerStatus,
      networks: brokerNetworks,
      proxyForwards: brokerForwards,
    },
    proxyManager: {
      status: proxyStatus,
    },
  };
}

async function collectAppServerStatuses(apps) {
  return Promise.all((Array.isArray(apps) ? apps : []).flatMap((app) =>
    (Array.isArray(app.servers) ? app.servers : []).map(async (server) => ({
      appId: app.id,
      name: server.name,
      port: server.port,
      running: await probeLocalPort(server.port),
    }))
  ));
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

function fetchJsonFrom(rawUrl) {
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
    request.setTimeout(1500, () => {
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
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeJson(res, 405, { ok: false, error: 'pw-dev GUI is read-only' });
    return;
  }

  const suffix = requestUrl.pathname.slice('/api/pwdev'.length);
  const upstreamUrl = new URL(`/_pwdev${suffix || ''}${requestUrl.search}`, ensureTrailingSlash(pwDevUrl));
  const upstream = http.request(upstreamUrl, {
    method: req.method,
    headers: { accept: req.headers.accept || 'application/json' },
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
  upstream.end();
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
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeJson(res, 405, { ok: false, error: 'Whistle GUI proxy only supports GET and HEAD' });
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
  const upstream = http.request(upstreamUrl, {
    method: req.method,
    headers: {
      accept: req.headers.accept || '*/*',
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
  upstream.end();
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
