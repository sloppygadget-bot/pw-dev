import http from 'node:http';
import net from 'node:net';
import { URL } from 'node:url';

export function createBrokerServer({ browserManager, proxyForwardManager, networkManager, topology } = {}) {
  const brokerTopology = normalizeBrokerTopology(topology);
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url?.startsWith('/_broker/') && !req.url.startsWith('/_broker/instances/')) {
        await handleControlRequest({ req, res, browserManager, proxyForwardManager, networkManager, brokerTopology });
        return;
      }

      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' });
        res.end('Method Not Allowed');
        return;
      }

      if (req.url === '/' || req.url === '/healthz') {
        const instances = browserManager?.listInstances?.() ?? [];
        const instance = instances.length === 1 ? instances[0] : undefined;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            running: instances.length > 0,
            topology: brokerTopology,
            chrome: instance ? `${instance.chromeHost}:${instance.chromePort}` : null,
            instances,
          })
        );
        return;
      }

      const route = resolveCdpRoute({ url: req.url, browserManager });
      await proxyHttpRequest({ req, res, route });
    } catch (error) {
      writeError(res, error);
    }
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      const route = resolveCdpRoute({ url: req.url, browserManager });
      proxyUpgrade({ req, socket, head, route });
    } catch (error) {
      socket.write(
        `HTTP/1.1 ${error.statusCode || 502} ${http.STATUS_CODES[error.statusCode] || 'Bad Gateway'}\r\n\r\n`
      );
      socket.destroy();
    }
  });

  return server;
}

export function rewriteDebuggerUrls(value, brokerBaseUrl) {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteDebuggerUrls(item, brokerBaseUrl));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const rewritten = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      typeof child === 'string' &&
      (key === 'webSocketDebuggerUrl' || key.endsWith('WebSocketDebuggerUrl'))
    ) {
      rewritten[key] = rewriteWebSocketUrl(child, brokerBaseUrl);
    } else {
      rewritten[key] = rewriteDebuggerUrls(child, brokerBaseUrl);
    }
  }
  return rewritten;
}

async function handleControlRequest({ req, res, browserManager, proxyForwardManager, networkManager, brokerTopology }) {
  if (
    (req.url === '/_broker/help' || req.url === '/_broker/instructions') &&
    req.method === 'GET'
  ) {
    writeText(res, 200, 'text/markdown; charset=utf-8', brokerInstructions(requestBaseUrl(req)));
    return;
  }

  if (req.url === '/_broker/client.js' && req.method === 'GET') {
    writeText(res, 200, 'text/javascript; charset=utf-8', brokerClientSource(requestBaseUrl(req)));
    return;
  }

  if (req.url === '/_broker/proxy-forwards' && req.method === 'GET') {
    const instances = browserManager?.listInstances?.() ?? [];
    writeJson(res, 200, {
      ok: true,
      forwards: proxyForwardManager?.list?.(instances) ?? [],
    });
    return;
  }

  if (req.url === '/_broker/proxy-forwards' && req.method === 'POST') {
    if (!proxyForwardManager?.create) {
      writeJson(res, 404, { ok: false, error: 'Proxy forward lifecycle is not enabled' });
      return;
    }
    const options = await readJsonBody(req);
    const forward = await proxyForwardManager.create(options);
    writeJson(res, 200, { ok: true, ...forward });
    return;
  }

  if (req.url === '/_broker/networks' && (req.method === 'GET' || req.method === 'HEAD')) {
    const instances = browserManager?.listInstances?.() ?? [];
    writeJson(res, 200, {
      ok: true,
      networks: networkManager?.list?.(instances) ?? [],
    });
    return;
  }

  if (req.url === '/_broker/networks' && req.method === 'POST') {
    if (!networkManager?.upsert) {
      writeJson(res, 404, { ok: false, error: 'Network lifecycle is not enabled' });
      return;
    }
    const instances = browserManager?.listInstances?.() ?? [];
    const network = await networkManager.upsert(await readJsonBody(req), instances);
    writeJson(res, 200, { ok: true, network });
    return;
  }

  const networkMatch = /^\/_broker\/networks\/([^/]+)(?:\/(check))?$/.exec(req.url || '');
  if (networkMatch) {
    if (!networkManager) {
      writeJson(res, 404, { ok: false, error: 'Network lifecycle is not enabled' });
      return;
    }
    const instances = browserManager?.listInstances?.() ?? [];
    const networkId = decodeURIComponent(networkMatch[1]);
    const action = networkMatch[2];
    if (!action && (req.method === 'GET' || req.method === 'HEAD')) {
      const network = networkManager.get(networkId, instances);
      writeJson(res, network ? 200 : 404, network
        ? { ok: true, network }
        : { ok: false, error: `Unknown network: ${networkId}` });
      return;
    }
    if (!action && req.method === 'DELETE') {
      const result = networkManager.delete(networkId, instances);
      writeJson(res, 200, { ok: true, ...result });
      return;
    }
    if (action === 'check' && req.method === 'POST') {
      const result = await networkManager.check(networkId, instances, await readJsonBody(req));
      writeJson(res, 200, { ok: true, ...result });
      return;
    }
  }

  const proxyForwardDelete = /^\/_broker\/proxy-forwards\/([^/]+)$/.exec(req.url || '');
  if (proxyForwardDelete && req.method === 'DELETE') {
    if (!proxyForwardManager?.delete) {
      writeJson(res, 404, { ok: false, error: 'Proxy forward lifecycle is not enabled' });
      return;
    }
    const instances = browserManager?.listInstances?.() ?? [];
    const result = proxyForwardManager.delete(decodeURIComponent(proxyForwardDelete[1]), instances);
    writeJson(res, 200, { ok: true, ...result });
    return;
  }

  if (req.url === '/_broker/status' && req.method === 'GET') {
    const instances = browserManager?.listInstances?.() ?? [];
    writeJson(res, 200, {
      ok: true,
      state: instances.length > 0 ? 'active' : 'idle',
      instanceCount: instances.length,
      topology: brokerTopology,
      instances,
      networks: networkManager?.list?.(instances) ?? [],
      proxyForwards: proxyForwardManager?.list?.(instances) ?? [],
    });
    return;
  }

  if (req.url === '/_broker/profiles/clear' && req.method === 'POST') {
    if (!browserManager?.clearProfileData) {
      writeJson(res, 404, { ok: false, error: 'Profile lifecycle is not enabled' });
      return;
    }
    const options = await readJsonBody(req);
    const result = browserManager.clearProfileData(options);
    writeJson(res, 200, { ok: true, ...result });
    return;
  }

  if (req.url === '/_broker/start' && req.method === 'POST') {
    if (!browserManager?.start) {
      writeJson(res, 404, { ok: false, error: 'Browser lifecycle is not enabled' });
      return;
    }
    const options = await readJsonBody(req);
    const instance = await browserManager.start(await resolveStartOptions({
      options,
      proxyForwardManager,
      networkManager,
      instances: browserManager?.listInstances?.() ?? [],
    }));
    writeJson(res, 200, {
      ok: true,
      instanceId: instance.id,
      cdpUrl: instanceBaseUrl(req, instance.id),
      profile: instance.profile,
      networkId: instance.networkId,
      proxyForwardId: instance.proxyForwardId,
      proxyServer: instance.proxyServer,
      headless: instance.headless,
      chromePid: instance.pid,
      startedAt: instance.startedAt,
    });
    return;
  }

  if (req.url === '/_broker/stop' && req.method === 'POST') {
    if (!browserManager?.stop) {
      writeJson(res, 404, { ok: false, error: 'Browser lifecycle is not enabled' });
      return;
    }
    const options = await readJsonBody(req);
    const result = await browserManager.stop(options);
    writeJson(res, 200, { ok: true, ...result });
    return;
  }

  writeJson(res, 404, { ok: false, error: 'Unknown broker endpoint' });
}

function normalizeBrokerTopology(topology) {
  if (!topology) return { mode: 'local', remote: false };
  return {
    mode: topology.mode ?? (topology.remote ? 'ssh' : 'local'),
    remote: Boolean(topology.remote),
    ...(topology.ssh ? { ssh: { ...topology.ssh } } : {}),
  };
}

async function resolveStartOptions({ options, proxyForwardManager, networkManager, instances }) {
  if (options.networkId && (options.proxyServer || options.proxyForwardId)) {
    const error = new Error('networkId is mutually exclusive with proxyServer and proxyForwardId');
    error.statusCode = 400;
    throw error;
  }
  if (options.proxyServer && options.proxyForwardId) {
    const error = new Error('proxyServer and proxyForwardId are mutually exclusive');
    error.statusCode = 400;
    throw error;
  }
  if (options.networkId) {
    const network = networkManager?.resolve?.(options.networkId, instances);
    if (!network) {
      const error = new Error(`Unknown network: ${options.networkId}`);
      error.statusCode = 404;
      throw error;
    }
    return omitUndefined({
      ...options,
      proxyServer: network.proxyServer,
      proxyForwardId: network.proxyForwardId,
      proxyBypassList: options.proxyBypassList ?? network.proxyBypassList,
      ignoreSslErrors: options.ignoreSslErrors ?? network.ignoreSslErrors,
    });
  }
  if (options.proxyPeer === 'ssh-peer') {
    if (options.proxyForwardId || !options.proxyServer) {
      const error = new Error('ssh-peer proxy resolution requires proxyServer without proxyForwardId');
      error.statusCode = 400;
      throw error;
    }
    const remotePort = proxyPort(options.proxyServer);
    const forward = await proxyForwardManager?.ensure?.({
      remotePort,
      name: options.proxyName,
    });
    if (!forward) {
      const error = new Error('ssh-peer proxy resolution requires broker --ssh');
      error.statusCode = 400;
      throw error;
    }
    const { proxyPeer: _proxyPeer, proxyName: _proxyName, ...launchOptions } = options;
    return {
      ...launchOptions,
      proxyForwardId: forward.forwardId,
      proxyServer: forward.proxyServer,
    };
  }
  if (!options.proxyForwardId) return options;
  const forward = proxyForwardManager?.get?.(options.proxyForwardId, instances);
  if (!forward) {
    const error = new Error(`Unknown proxy forward: ${options.proxyForwardId}`);
    error.statusCode = 404;
    throw error;
  }
  return {
    ...options,
    proxyServer: forward.proxyServer,
  };
}

function proxyPort(proxyServer) {
  let url;
  try {
    url = new URL(proxyServer);
  } catch {
    const error = new Error('proxyServer must be an absolute URL for ssh-peer proxy resolution');
    error.statusCode = 400;
    throw error;
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const error = new Error('proxyServer must include a valid TCP port for ssh-peer proxy resolution');
    error.statusCode = 400;
    throw error;
  }
  return port;
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

function rewriteWebSocketUrl(rawUrl, brokerBaseUrl) {
  const source = new URL(rawUrl);
  const broker = new URL(brokerBaseUrl);
  source.protocol = broker.protocol === 'https:' ? 'wss:' : 'ws:';
  source.hostname = broker.hostname;
  source.port = broker.port;
  source.pathname = joinUrlPath(broker.pathname, source.pathname);
  return source.toString();
}

async function proxyHttpRequest({ req, res, route }) {
  const body = await requestChrome({
    req,
    route,
  });

  const contentType = body.headers['content-type'] || '';
  const shouldRewrite =
    route.chromePath === '/json/version' ||
    route.chromePath === '/json' ||
    route.chromePath === '/json/list' ||
    contentType.includes('application/json');

  if (!shouldRewrite) {
    res.writeHead(body.statusCode, body.headers);
    res.end(body.buffer);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(body.buffer.toString('utf8'));
  } catch {
    res.writeHead(body.statusCode, body.headers);
    res.end(body.buffer);
    return;
  }

  const brokerBaseUrl = requestBaseUrl(req, route.brokerBasePath);
  const rewritten = rewriteDebuggerUrls(payload, brokerBaseUrl);
  const responseBody = Buffer.from(JSON.stringify(rewritten, null, 2));
  const {
    'content-length': _contentLength,
    'transfer-encoding': _transferEncoding,
    ...headers
  } = body.headers;
  res.writeHead(body.statusCode, {
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'content-length': responseBody.length,
  });
  res.end(responseBody);
}

function requestChrome({ req, route }) {
  return new Promise((resolve, reject) => {
    const headers = { ...req.headers, host: `${route.chromeHost}:${route.chromePort}` };
    const request = http.request(
      {
        host: route.chromeHost,
        port: route.chromePort,
        method: req.method,
        path: route.chromePath,
        headers,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode || 502,
            headers: response.headers,
            buffer: Buffer.concat(chunks),
          });
        });
      }
    );
    request.once('error', reject);
    req.pipe(request);
  });
}

function proxyUpgrade({ req, socket, head, route }) {
  const upstream = net.connect(route.chromePort, route.chromeHost);

  upstream.once('connect', () => {
    upstream.write(buildUpgradeRequest(req, route));
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.once('error', (error) => {
    if (!socket.destroyed) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      socket.destroy(error);
    }
  });

  socket.once('error', () => {
    upstream.destroy();
  });
}

function buildUpgradeRequest(req, route) {
  const lines = [`${req.method} ${route.chromePath} HTTP/${req.httpVersion}`];
  const rawHeaders = req.rawHeaders || [];
  let wroteHost = false;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (name.toLowerCase() === 'host') {
      lines.push(`Host: ${route.chromeHost}:${route.chromePort}`);
      wroteHost = true;
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  if (!wroteHost) lines.push(`Host: ${route.chromeHost}:${route.chromePort}`);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

function resolveCdpRoute({ url, browserManager }) {
  const instanceRoute = parseInstanceRoute(url);
  if (instanceRoute) {
    const instance = browserManager?.getInstance?.(instanceRoute.instanceId);
    if (!instance) {
      const error = new Error(`Unknown browser instance: ${instanceRoute.instanceId}`);
      error.statusCode = 404;
      throw error;
    }
    return {
      chromeHost: instance.chromeHost,
      chromePort: instance.chromePort,
      chromePath: instanceRoute.chromePath,
      brokerBasePath: instanceRoute.brokerBasePath,
    };
  }

  const instance = browserManager?.activeInstance?.();
  if (!instance) {
    const error = new Error('Chrome is not running');
    error.statusCode = 503;
    throw error;
  }
  return {
    chromeHost: instance.chromeHost,
    chromePort: instance.chromePort,
    chromePath: url,
    brokerBasePath: '',
  };
}

function parseInstanceRoute(url) {
  const match = /^\/_broker\/instances\/([^/]+)(\/.*)?$/.exec(url || '');
  if (!match) return undefined;
  return {
    instanceId: decodeURIComponent(match[1]),
    brokerBasePath: `/_broker/instances/${match[1]}`,
    chromePath: match[2] || '/',
  };
}

function requestBaseUrl(req, brokerBasePath = '') {
  const host = req.headers.host;
  const encrypted = Boolean(req.socket.encrypted);
  return `${encrypted ? 'https' : 'http'}://${host}${brokerBasePath}`;
}

function instanceBaseUrl(req, instanceId) {
  return `${requestBaseUrl(req)}/_broker/instances/${encodeURIComponent(instanceId)}`;
}

function joinUrlPath(prefix, suffix) {
  const normalizedPrefix = prefix === '/' ? '' : prefix.replace(/\/$/, '');
  const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return `${normalizedPrefix}${normalizedSuffix}`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        error.statusCode = 400;
        reject(error);
      }
    });
    req.once('error', reject);
  });
}

function writeJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
  });
  res.end(body);
}

function writeText(res, statusCode, contentType, text) {
  const body = Buffer.from(text);
  res.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': body.length,
  });
  res.end(body);
}

function writeError(res, error) {
  const statusCode = error?.statusCode || 502;
  writeJson(res, statusCode, {
    ok: false,
    error: error?.message || http.STATUS_CODES[statusCode] || 'Bad Gateway',
  });
}

function brokerInstructions(brokerUrl) {
  return `# pw-cdp-broker remote Playwright instructions

This broker starts local Chrome on demand and returns the CDP URL that remote
Playwright must use.

## Start an instance

\`\`\`js
const start = await fetch('${brokerUrl}/_broker/start', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    profile: 'work-okta',
    headless: false,
    ignoreSslErrors: true,
  }),
}).then((response) => response.json());
\`\`\`

## Connect Playwright

\`\`\`js
const browser = await chromium.connectOverCDP(start.cdpUrl);
const context = browser.contexts()[0];
const page = context.pages()[0] ?? await context.newPage();
\`\`\`

Remote Playwright can inspect DOM and capture screenshots through the connected
page. Video recording for broker-controlled persistent sessions is not part of
this helper.

## Clear persistent profile data

\`\`\`js
await fetch('${brokerUrl}/_broker/profiles/clear', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ profile: 'work-okta' }),
});
\`\`\`

The broker rejects clearing a profile while a running instance is using it.

## Browser networks

\`\`\`js
const network = await fetch('${brokerUrl}/_broker/networks', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    id: 'agent-whistle',
    kind: 'whistle',
    proxy: { mode: 'ssh-peer', remotePort: 8899 },
    browser: { ignoreSslErrors: true },
  }),
}).then((response) => response.json());

const proxied = await fetch('${brokerUrl}/_broker/start', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    profile: 'work-okta',
    networkId: network.network.id,
  }),
}).then((response) => response.json());
\`\`\`

Use \`proxy.mode: "ssh-peer"\` when the proxy is on the SSH peer configured by
broker \`--ssh\`. The broker creates and owns the underlying SSH proxy forward.
Use \`proxy.mode: "direct"\` or \`"broker-local"\` when the proxy URL is already
reachable from the broker/Chrome host.

The lower-level \`/_broker/proxy-forwards\` API remains available for debugging
and compatibility when callers need a raw \`proxyForwardId\`.

## Status and cleanup

\`\`\`js
const status = await fetch('${brokerUrl}/_broker/status').then((response) => response.json());

if (status.topology?.remote && status.topology.mode === 'ssh') {
  // Broker was started with --ssh; the SSH peer is the broker's remote network side.
}

await fetch('${brokerUrl}/_broker/stop', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instanceId: start.instanceId }),
});
\`\`\`

Helper source is available from:

\`\`\`text
GET /_broker/client.js
\`\`\`
`;
}

function brokerClientSource(brokerUrl) {
  return `import { chromium } from 'playwright';

export async function connectViaBroker({
  brokerUrl = '${brokerUrl}',
  profile,
  networkId,
  proxyServer,
  proxyForwardId,
  proxyBypassList,
  ignoreSslErrors,
  headless,
} = {}) {
  const response = await fetch(\`\${brokerUrl}/_broker/start\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      profile,
      networkId,
      proxyServer,
      proxyForwardId,
      proxyBypassList,
      ignoreSslErrors,
      headless,
    }),
  });

  if (!response.ok) {
    throw new Error(\`Broker start failed: \${response.status} \${await response.text()}\`);
  }

  const instance = await response.json();
  const browser = await chromium.connectOverCDP(instance.cdpUrl);

  return {
    browser,
    instance,
    stop: async () => {
      const stopResponse = await fetch(\`\${brokerUrl}/_broker/stop\`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instanceId: instance.instanceId }),
      });
      if (!stopResponse.ok) {
        throw new Error(\`Broker stop failed: \${stopResponse.status} \${await stopResponse.text()}\`);
      }
    },
  };
}
`;
}
