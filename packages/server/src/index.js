// @ts-check

/**
 * Dependency-light pw-dev HTTP server.
 *
 * This module serves two surfaces:
 * - static app files from a configured root directory
 * - `/_pwdev/*` JSON/JavaScript/Markdown endpoints for app discovery,
 *   app registration, and broker-backed browser session coordination
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
]);

const DEFAULT_BROKER_URL = 'http://127.0.0.1:18080';
const DEFAULT_W2MGR_URL = 'http://127.0.0.1:18081';

/**
 * Options for `startPwDevServer`.
 *
 * The scalar app fields seed the server's own default manifest and app
 * registry entry. Additional apps can be registered later through
 * `POST /_pwdev/apps`.
 *
 * @typedef {object} PwDevServerOptions
 * @property {string=} host HTTP listen host. Defaults to `127.0.0.1`.
 * @property {number=} port HTTP listen port. Defaults to `9696`; use `0` for an ephemeral port.
 * @property {string=} root Static file root. Defaults to the current working directory.
 * @property {string=} id App id for the seeded manifest. Defaults to the worktree basename.
 * @property {string=} name Human-readable app name. Defaults to `id`.
 * @property {string=} worktree Local worktree path. Defaults to `root`.
 * @property {string=} branch Source branch name for display/discovery.
 * @property {string=} appUrl URL of the actual app devserver. Defaults to this server's origin.
 * @property {string=} brokerUrl Broker base URL paired with this server for browser lifecycle endpoints. Defaults to `http://127.0.0.1:18080`.
 * @property {string=} w2mgrUrl Optional w2mgr base URL proxied under `/_pwdev/w2mgr/*`. Defaults to `http://127.0.0.1:18081`.
 * @property {string=} cdpUrl Optional Playwright CDP URL for direct browser attachment.
 * @property {string=} profile Optional broker profile name for the app.
 * @property {string=} proxyId Optional proxy registry id for the app.
 * @property {string=} proxyForwardId Optional broker-managed proxy forward id, for example a Whistle tunnel.
 * @property {string=} proxyServer Optional Chrome proxy server URL.
 */

/**
 * App manifest returned from `/_pwdev/manifest` and
 * `/_pwdev/apps/:id/manifest`.
 *
 * Agents should treat `appUrl` and a browser CDP URL as the primary attach
 * contract: load the app at `appUrl`, and connect Playwright over app `cdpUrl`
 * for the default browser slot or `browserSessions[sessionId].cdpUrl` for a
 * task-scoped browser session.
 *
 * @typedef {object} PwDevAppManifest
 * @property {true} ok
 * @property {string} id Stable app id, usually derived from worktree or branch.
 * @property {string=} name Human-readable app name.
 * @property {string=} root Static root associated with the app.
 * @property {string=} worktree Local worktree path.
 * @property {string=} branch Source branch name.
 * @property {string=} appUrl URL agents should navigate to.
 * @property {PwDevDevserverCommand=} devserver Command metadata for starting the app GUI devserver.
 * @property {PwDevAppEngine=} engine Runtime engine metadata for the app.
 * @property {Record<string, PwDevAccountCredentials>=} accounts Named credentials for agent-assisted login.
 * @property {string=} brokerUrl Advanced per-app broker override. Normal app registration should not set this.
 * @property {string=} cdpUrl Playwright CDP URL for direct browser attachment.
 * @property {string=} profile Broker profile name associated with this app.
 * @property {string=} proxyId Reusable proxy registry id associated with this app.
 * @property {string=} proxyForwardId Broker proxy-forward id associated with this app.
 * @property {string=} proxyServer Explicit Chrome proxy server URL associated with this app.
 * @property {string=} browserInstanceId Broker instance id for a managed browser session.
 * @property {string=} browserStartedAt ISO timestamp returned by the broker for the managed browser session.
 * @property {PwDevActiveTask=} activeTask Agent/user task that currently owns the browser session.
 * @property {Record<string, PwDevBrowserSession>=} browserSessions Task-scoped browser sessions for parallel app work.
 * @property {string=} serverUrl pw-dev server URL that registered or serves this app.
 * @property {string=} createdAt Registry creation timestamp.
 * @property {string=} updatedAt Registry update timestamp.
 */

/**
 * Mutable app registry interface used by `/_pwdev/apps` routes.
 *
 * @typedef {object} PwDevAppRegistry
 * @property {() => PwDevAppManifest[]} list Returns registered apps sorted by id.
 * @property {(id: string) => (PwDevAppManifest | undefined)} get Returns one app by id.
 * @property {(rawApp: Record<string, unknown>) => PwDevAppManifest} upsert Creates or replaces app metadata by id.
 * @property {(id: string, patch: Record<string, unknown>) => (PwDevAppManifest | undefined)} update Applies a partial patch; `undefined` deletes optional fields.
 * @property {(id: string) => boolean} delete Removes an app by id.
 */

/**
 * Named account credentials for an app.
 *
 * Store only non-production test accounts here. Do not register production or
 * personal credentials.
 *
 * @typedef {object} PwDevAccountCredentials
 * @property {string} usr Login username.
 * @property {string} pwd Login password.
 * @property {string=} label Human-readable account label.
 */

/**
 * Reusable proxy registry record.
 *
 * Proxies are configuration only. They do not carry runner or status fields.
 * Apps should reference a proxy by `proxyId` instead of duplicating proxy
 * details across app records.
 *
 * @typedef {object} PwDevProxyRecord
 * @property {string} id Stable proxy id.
 * @property {string=} kind Proxy kind, for example `whistle` or `http`.
 * @property {string=} name Human-readable proxy name.
 * @property {string=} proxyUrl Direct Chrome proxy server URL, for example `http://127.0.0.1:8899`.
 * @property {string=} brokerProxyForwardId Broker-managed proxy forward id.
 * @property {string=} createdAt Registry creation timestamp.
 * @property {string=} updatedAt Registry update timestamp.
 */

/**
 * Mutable proxy registry interface used by `/_pwdev/proxies` routes.
 *
 * @typedef {object} PwDevProxyRegistry
 * @property {() => PwDevProxyRecord[]} list Returns registered proxies sorted by id.
 * @property {(id: string) => (PwDevProxyRecord | undefined)} get Returns one proxy by id.
 * @property {(rawProxy: Record<string, unknown>) => PwDevProxyRecord} upsert Creates or replaces proxy metadata by id.
 * @property {(id: string) => boolean} delete Removes a proxy by id.
 */

/**
 * Command metadata for starting an app devserver.
 *
 * pw-dev records this for agents/humans but does not execute it yet.
 *
 * @typedef {object} PwDevDevserverCommand
 * @property {string} command Base command, for example `npm`.
 * @property {string[]=} args Command arguments, for example `["run", "dev"]`.
 * @property {string=} cwd Working directory. Defaults to app worktree when omitted.
 * @property {Record<string, string>=} env Environment variables needed by the devserver.
 */

/**
 * Runtime engine metadata for the app.
 *
 * @typedef {object} PwDevAppEngine
 * @property {string=} name Engine name, for example `node`.
 * @property {string=} version Exact detected version, for example `v22.16.0`.
 * @property {string=} requirement Declared requirement, for example `>=18`.
 */

/**
 * Agent/user task metadata attached to an active app browser session.
 *
 * This lives at the server layer because it explains why a browser exists. The
 * broker still owns only technical Chrome process state.
 *
 * @typedef {object} PwDevActiveTask
 * @property {string} id Stable task id.
 * @property {string=} label Human-readable task label.
 * @property {string=} owner Agent/user/tool that owns the task.
 * @property {string} startedAt Server timestamp when the task was attached to the browser session.
 */

/**
 * Task-scoped browser session metadata stored on an app.
 *
 * @typedef {object} PwDevBrowserSession
 * @property {string} sessionId Stable session id, composed as `<app id>__<task id>`.
 * @property {string} taskId Task id that owns the session.
 * @property {string} profile Broker profile used by the session.
 * @property {string} cdpUrl Server-proxied CDP URL.
 * @property {string} browserInstanceId Broker instance id for the Chrome process.
 * @property {string=} browserStartedAt ISO timestamp returned by the broker.
 * @property {string=} proxyId Reusable proxy registry id associated with the session.
 * @property {string=} proxyForwardId Broker proxy-forward id associated with the session.
 * @property {string=} proxyServer Explicit Chrome proxy server URL associated with the session.
 * @property {PwDevActiveTask} activeTask Task metadata that owns the session.
 */

/**
 * Task metadata accepted by `/_pwdev/apps/:id/browser/start`.
 *
 * @typedef {object} PwDevTaskInput
 * @property {string} id Stable task id.
 * @property {string=} label Human-readable task label.
 * @property {string=} owner Agent/user/tool that owns the task.
 */

/**
 * Server-level broker pairing.
 *
 * The pw-dev server should normally pair with one default broker. Apps can use
 * profiles and proxy metadata, but they should not have to carry broker
 * location as normal app metadata.
 *
 * @typedef {object} PwDevBrokerPairing
 * @property {() => { configured: boolean, url: string, default?: boolean }} summary Returns broker configuration status.
 * @property {() => Promise<Record<string, unknown>>} status Returns broker configuration and reachability status.
 * @property {(overrideUrl?: string) => string} resolve Returns an override URL or the configured broker URL.
 */

/**
 * Runtime options accepted by `/_pwdev/apps/:id/browser/start`.
 *
 * @typedef {object} PwDevBrowserStartOptions
 * @property {string=} brokerUrl Advanced broker base URL override. Defaults to server-level broker pairing.
 * @property {string=} profile Broker profile override. Defaults to the app profile, then app id.
 * @property {string=} proxyId Reusable proxy registry id. Defaults to app `proxyId`.
 * @property {string=} proxyForwardId Broker proxy-forward id for proxied apps.
 * @property {string=} proxyServer Explicit Chrome proxy server URL.
 * @property {string=} proxyBypassList Chrome proxy bypass list.
 * @property {boolean=} ignoreSslErrors Launch Chrome with SSL errors ignored.
 * @property {boolean=} headless Launch Chrome headless through broker.
 * @property {boolean=} resetProfile Clear the profile before starting.
 * @property {PwDevTaskInput=} task Task metadata to attach to this browser session.
 */

/**
 * Start a pw-dev HTTP server.
 *
 * The returned server exposes the root app manifest at `/_pwdev/manifest`,
 * central app registry routes at `/_pwdev/apps`, and static files for all other
 * GET/HEAD paths. Browser lifecycle requests are delegated to the broker URL
 * paired with this server through `brokerUrl`.
 *
 * @param {PwDevServerOptions=} options
 * @returns {Promise<{ origin: string, root: string, server: http.Server, close: () => Promise<void> }>}
 */
export async function startPwDevServer(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 9696;
  const root = path.resolve(options.root ?? process.cwd());
  const worktree = options.worktree ? path.resolve(options.worktree) : root;
  const metadata = validateMetadata({
    id: options.id ?? defaultAppId(worktree),
    name: options.name,
    branch: options.branch,
    appUrl: options.appUrl,
    cdpUrl: options.cdpUrl,
    profile: options.profile,
    proxyId: options.proxyId,
    proxyForwardId: options.proxyForwardId,
    proxyServer: options.proxyServer,
  });
  const startedAt = new Date().toISOString();
  const broker = createBrokerPairing({ brokerUrl: options.brokerUrl });
  const w2mgrUrl = normalizeHttpUrl(options.w2mgrUrl ?? DEFAULT_W2MGR_URL, 'w2mgrUrl');
  const apps = createAppRegistry();
  const proxies = createProxyRegistry();
  apps.upsert(buildManifest({ root, worktree, origin: undefined, metadata }));
  let origin;

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url?.startsWith('/_pwdev/')) {
        await handlePwDevRequest({ req, res, root, worktree, origin, startedAt, metadata, apps, proxies, broker, w2mgrUrl });
        return;
      }
      if (req.url === '/healthz' || req.url === '/health') {
        writeJson(res, 200, { ok: true, root });
        return;
      }
      await serveStatic({ req, res, root });
    } catch (error) {
      writeJson(res, error?.statusCode || 500, {
        ok: false,
        error: error?.message || 'Internal Server Error',
      });
    }
  });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/_pwdev/broker')) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    proxyBrokerUpgrade({ req, socket, head, broker });
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
  origin = `http://${host}:${actualPort}`;
  apps.upsert(buildManifest({ root, worktree, origin, metadata }));

  return {
    origin,
    root,
    server,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

/**
 * Dispatches all `/_pwdev/*` requests.
 *
 * Public routes handled here:
 * - `GET /_pwdev/manifest`
 * - `GET /_pwdev/status`
 * - `GET /_pwdev/instructions`
 * - `GET /_pwdev/client.js`
 * - `ANY /_pwdev/broker/*`
 * - `ANY /_pwdev/w2mgr/*`
 * - `GET|POST /_pwdev/apps`
 * - `GET|DELETE /_pwdev/apps/:id`
 * - `GET /_pwdev/apps/:id/manifest`
 * - `GET /_pwdev/apps/:id/browser/status`
 * - `POST /_pwdev/apps/:id/browser/start`
 * - `POST /_pwdev/apps/:id/browser/stop`
 * - `GET|POST /_pwdev/proxies`
 * - `GET|DELETE /_pwdev/proxies/:id`
 *
 * @param {{
 *   req: http.IncomingMessage,
 *   res: http.ServerResponse,
 *   root: string,
 *   worktree: string,
 *   origin: string | undefined,
 *   startedAt: string,
 *   metadata: Record<string, string | undefined>,
 *   apps: PwDevAppRegistry,
 *   proxies: PwDevProxyRegistry,
 *   broker: PwDevBrokerPairing,
 *   w2mgrUrl: string,
 * }} options
 * @returns {Promise<void>}
 */
export async function handlePwDevRequest({ req, res, root, worktree, origin, startedAt, metadata, apps, proxies, broker, w2mgrUrl }) {
  const requestUrl = new URL(req.url || '/', 'http://local');
  const serverUrl = origin ?? requestBaseUrl(req);
  const manifest = buildManifest({ root, worktree, origin: serverUrl, metadata });
  const writeBody = req.method !== 'HEAD';

  if (requestUrl.pathname.startsWith('/_pwdev/broker')) {
    await proxyBrokerHttpRequest({ req, res, requestUrl, broker });
    return;
  }

  if (requestUrl.pathname.startsWith('/_pwdev/w2mgr')) {
    await proxyW2MgrHttpRequest({ req, res, requestUrl, w2mgrUrl });
    return;
  }

  if (requestUrl.pathname.startsWith('/_pwdev/apps')) {
    await handleAppsRequest({ req, res, requestUrl, apps, proxies, broker, serverUrl, writeBody });
    return;
  }

  if (requestUrl.pathname.startsWith('/_pwdev/proxies')) {
    await handleProxiesRequest({ req, res, requestUrl, proxies, writeBody });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  if (requestUrl.pathname === '/_pwdev/manifest') {
    writeJson(res, 200, manifest, writeBody);
    return;
  }

  if (requestUrl.pathname === '/_pwdev/status') {
    writeJson(res, 200, {
      ok: true,
      startedAt,
      serverUrl,
      root,
      worktree,
      broker: await broker.status(),
      w2mgr: { url: w2mgrUrl },
      proxies: proxies.list(),
      manifest,
    }, writeBody);
    return;
  }

  if (requestUrl.pathname === '/_pwdev/instructions') {
    writeTypedText(
      res,
      200,
      'text/markdown; charset=utf-8',
      pwDevInstructions(serverUrl),
      writeBody
    );
    return;
  }

  if (requestUrl.pathname === '/_pwdev/client.js') {
    writeTypedText(
      res,
      200,
      'text/javascript; charset=utf-8',
      pwDevClientSource(serverUrl),
      writeBody
    );
    return;
  }

  writeJson(res, 404, { ok: false, error: 'Unknown pw-dev endpoint' }, writeBody);
}

/**
 * Build an app manifest from root/worktree paths and scalar metadata.
 *
 * Undefined optional fields are omitted so the manifest stays concise. When
 * `metadata.appUrl` is absent, `origin` becomes the default app URL.
 *
 * @param {{ root: string, worktree: string, origin: string | undefined, metadata: Record<string, string | undefined> }} options
 * @returns {PwDevAppManifest}
 */
export function buildManifest({ root, worktree, origin, metadata }) {
  return omitUndefined({
    ok: true,
    id: metadata.id,
    name: metadata.name ?? metadata.id,
    root,
    worktree,
    branch: metadata.branch,
    appUrl: metadata.appUrl ?? origin,
    brokerUrl: metadata.brokerUrl,
    cdpUrl: metadata.cdpUrl,
    profile: metadata.profile,
    proxyId: metadata.proxyId,
    proxyForwardId: metadata.proxyForwardId,
    proxyServer: metadata.proxyServer,
    serverUrl: origin,
  });
}

/**
 * Create an in-memory app registry.
 *
 * This registry is intentionally process-local. It is suitable for a dev
 * daemon that tracks currently running branches and broker sessions; persistence
 * can be layered behind this interface later without changing route handlers.
 *
 * @param {Record<string, unknown>[]=} initialApps Initial app entries to seed.
 * @returns {PwDevAppRegistry}
 */
export function createAppRegistry(initialApps = []) {
  const apps = new Map();
  const registry = {
    list() {
      return Array.from(apps.values())
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((app) => cloneApp(app));
    },
    get(id) {
      const app = apps.get(id);
      return app ? cloneApp(app) : undefined;
    },
    upsert(rawApp) {
      const app = validateAppRegistration(rawApp);
      const existing = apps.get(app.id);
      const saved = {
        ...existing,
        ...app,
        updatedAt: new Date().toISOString(),
      };
      if (!saved.name) saved.name = saved.id;
      if (!existing?.createdAt) saved.createdAt = saved.updatedAt;
      apps.set(saved.id, saved);
      return cloneApp(saved);
    },
    update(id, patch) {
      const existing = apps.get(id);
      if (!existing) return undefined;
      const saved = { ...existing };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) {
          delete saved[key];
        } else {
          saved[key] = value;
        }
      }
      saved.updatedAt = new Date().toISOString();
      apps.set(id, saved);
      return cloneApp(saved);
    },
    delete(id) {
      return apps.delete(id);
    },
  };

  for (const app of initialApps) registry.upsert(app);
  return registry;
}

function cloneApp(app) {
  return {
    ...app,
    ...(app.activeTask ? { activeTask: { ...app.activeTask } } : {}),
    ...(app.browserSessions ? { browserSessions: cloneBrowserSessions(app.browserSessions) } : {}),
  };
}

function cloneBrowserSessions(sessions) {
  return Object.fromEntries(Object.entries(sessions).map(([id, session]) => [
    id,
    {
      ...session,
      ...(session.activeTask ? { activeTask: { ...session.activeTask } } : {}),
    },
  ]));
}

/**
 * Create an in-memory proxy registry.
 *
 * @param {Record<string, unknown>[]=} initialProxies Initial proxy entries to seed.
 * @returns {PwDevProxyRegistry}
 */
export function createProxyRegistry(initialProxies = []) {
  const proxies = new Map();
  const registry = {
    list() {
      return Array.from(proxies.values())
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((proxy) => ({ ...proxy }));
    },
    get(id) {
      const proxy = proxies.get(id);
      return proxy ? { ...proxy } : undefined;
    },
    upsert(rawProxy) {
      const proxy = validateProxyRegistration(rawProxy);
      const existing = proxies.get(proxy.id);
      const saved = {
        ...existing,
        ...proxy,
        updatedAt: new Date().toISOString(),
      };
      if (!existing?.createdAt) saved.createdAt = saved.updatedAt;
      proxies.set(saved.id, saved);
      return { ...saved };
    },
    delete(id) {
      return proxies.delete(id);
    },
  };

  for (const proxy of initialProxies) registry.upsert(proxy);
  return registry;
}

/**
 * Handle reusable proxy registry routes under `/_pwdev/proxies`.
 *
 * `POST /_pwdev/proxies` is an upsert. Apps reference proxies by `proxyId`,
 * allowing one proxy configuration to be reused across multiple apps.
 *
 * @param {{
 *   req: http.IncomingMessage,
 *   res: http.ServerResponse,
 *   requestUrl: URL,
 *   proxies: PwDevProxyRegistry,
 *   writeBody: boolean,
 * }} options
 * @returns {Promise<void>}
 */
async function handleProxiesRequest({ req, res, requestUrl, proxies, writeBody }) {
  const pathParts = requestUrl.pathname.split('/').filter(Boolean);

  if (pathParts.length === 2 && pathParts[0] === '_pwdev' && pathParts[1] === 'proxies') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      writeJson(res, 200, { ok: true, proxies: proxies.list() }, writeBody);
      return;
    }

    if (req.method === 'POST') {
      const payload = await readJsonBody(req);
      const proxy = proxies.upsert(payload);
      writeJson(res, 200, { ok: true, proxy });
      return;
    }

    res.writeHead(405, { allow: 'GET, HEAD, POST' });
    res.end('Method Not Allowed');
    return;
  }

  const id = pathParts[2] ? decodeURIComponent(pathParts[2]) : undefined;
  if (!id || pathParts[0] !== '_pwdev' || pathParts[1] !== 'proxies' || pathParts.length !== 3) {
    writeJson(res, 404, { ok: false, error: 'Unknown pw-dev proxies endpoint' }, writeBody);
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const proxy = proxies.get(id);
    if (!proxy) {
      writeJson(res, 404, { ok: false, error: `Unknown proxy: ${id}` }, writeBody);
      return;
    }
    writeJson(res, 200, { ok: true, proxy }, writeBody);
    return;
  }

  if (req.method === 'DELETE') {
    const deleted = proxies.delete(id);
    writeJson(res, deleted ? 200 : 404, deleted
      ? { ok: true, id }
      : { ok: false, error: `Unknown proxy: ${id}` });
    return;
  }

  res.writeHead(405, { allow: 'GET, HEAD, DELETE' });
  res.end('Method Not Allowed');
}

/**
 * Handle central app registry routes under `/_pwdev/apps`.
 *
 * `POST /_pwdev/apps` is an upsert. Re-posting the same app id updates branch
 * devserver URLs, profile names, proxy metadata, and CDP endpoints in place.
 *
 * @param {{
 *   req: http.IncomingMessage,
 *   res: http.ServerResponse,
 *   requestUrl: URL,
 *   apps: PwDevAppRegistry,
 *   proxies: PwDevProxyRegistry,
 *   broker: PwDevBrokerPairing,
 *   serverUrl: string,
 *   writeBody: boolean,
 * }} options
 * @returns {Promise<void>}
 */
async function handleAppsRequest({ req, res, requestUrl, apps, proxies, broker, serverUrl, writeBody }) {
  const pathParts = requestUrl.pathname.split('/').filter(Boolean);

  if (pathParts.length === 2 && pathParts[0] === '_pwdev' && pathParts[1] === 'apps') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      writeJson(res, 200, { ok: true, apps: apps.list() }, writeBody);
      return;
    }

    if (req.method === 'POST') {
      const payload = await readJsonBody(req);
      const app = apps.upsert({
        ...payload,
        serverUrl: payload.serverUrl ?? serverUrl,
      });
      writeJson(res, 200, { ok: true, app });
      return;
    }

    res.writeHead(405, { allow: 'GET, HEAD, POST' });
    res.end('Method Not Allowed');
    return;
  }

  const id = pathParts[2] ? decodeURIComponent(pathParts[2]) : undefined;
  if (!id || pathParts[0] !== '_pwdev' || pathParts[1] !== 'apps') {
    writeJson(res, 404, { ok: false, error: 'Unknown pw-dev apps endpoint' }, writeBody);
    return;
  }

  if (pathParts.length === 3) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const app = apps.get(id);
      if (!app) {
        writeJson(res, 404, { ok: false, error: `Unknown app: ${id}` }, writeBody);
        return;
      }
      writeJson(res, 200, { ok: true, app }, writeBody);
      return;
    }

    if (req.method === 'DELETE') {
      const deleted = apps.delete(id);
      writeJson(res, deleted ? 200 : 404, deleted
        ? { ok: true, id }
        : { ok: false, error: `Unknown app: ${id}` });
      return;
    }

    res.writeHead(405, { allow: 'GET, HEAD, DELETE' });
    res.end('Method Not Allowed');
    return;
  }

  if (pathParts.length === 4 && pathParts[3] === 'manifest') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end('Method Not Allowed');
      return;
    }
    const app = apps.get(id);
    if (!app) {
      writeJson(res, 404, { ok: false, error: `Unknown app: ${id}` }, writeBody);
      return;
    }
    writeJson(res, 200, app, writeBody);
    return;
  }

  if (pathParts.length === 5 && pathParts[3] === 'browser') {
    await handleAppBrowserRequest({
      req,
      res,
      apps,
      proxies,
      broker,
      serverUrl,
      id,
      command: pathParts[4],
      writeBody,
    });
    return;
  }

  writeJson(res, 404, { ok: false, error: 'Unknown pw-dev apps endpoint' }, writeBody);
}

/**
 * Serve static files from `root` for non-`/_pwdev` requests.
 *
 * Directory requests resolve to `index.html`. Paths are resolved through
 * `resolveStaticPath` so URL traversal cannot escape the configured root.
 *
 * @param {{ req: http.IncomingMessage, res: http.ServerResponse, root: string }} options
 * @returns {Promise<void>}
 */
export async function serveStatic({ req, res, root }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  const requestUrl = new URL(req.url || '/', 'http://local');
  const filePath = resolveStaticPath(root, requestUrl.pathname);
  if (!filePath) {
    writeText(res, 403, 'Forbidden');
    return;
  }

  const resolved = await resolveFile(filePath);
  if (!resolved) {
    writeText(res, 404, 'Not Found');
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

/**
 * Resolve a URL pathname to an absolute file path under `root`.
 *
 * @param {string} root Static file root.
 * @param {string} urlPathname URL pathname from the incoming request.
 * @returns {(string | undefined)} Absolute file path, or `undefined` for invalid/escaping paths.
 */
export function resolveStaticPath(root, urlPathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPathname);
  } catch {
    return undefined;
  }
  const absolute = path.resolve(root, `.${path.sep}${path.normalize(decoded)}`);
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

/**
 * Proxy broker HTTP APIs through the pw-dev server.
 *
 * `/_pwdev/broker/*` maps to the paired broker's `/_broker/*` namespace. This
 * keeps agents on the pw-dev server origin while still allowing raw broker APIs
 * as an advanced escape hatch.
 *
 * @param {{
 *   req: http.IncomingMessage,
 *   res: http.ServerResponse,
 *   requestUrl: URL,
 *   broker: PwDevBrokerPairing,
 * }} options
 * @returns {Promise<void>}
 */
async function proxyBrokerHttpRequest({ req, res, requestUrl, broker }) {
  const brokerUrl = broker.resolve();
  const upstreamUrl = new URL(proxyBrokerPath(requestUrl), ensureTrailingSlash(brokerUrl));
  const headers = { ...req.headers, host: upstreamUrl.host };

  const upstream = http.request(upstreamUrl, {
    method: req.method,
    headers,
  }, (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(res);
  });

  upstream.once('error', (error) => {
    writeBrokerError(res, error);
  });
  req.pipe(upstream);
}

/**
 * Proxy w2mgr HTTP APIs through the pw-dev server.
 *
 * `/_pwdev/w2mgr/*` maps to the manager's `/_w2mgr/*` namespace.
 *
 * @param {{
 *   req: http.IncomingMessage,
 *   res: http.ServerResponse,
 *   requestUrl: URL,
 *   w2mgrUrl: string,
 * }} options
 * @returns {Promise<void>}
 */
async function proxyW2MgrHttpRequest({ req, res, requestUrl, w2mgrUrl }) {
  const upstreamUrl = new URL(proxyW2MgrPath(requestUrl), ensureTrailingSlash(w2mgrUrl));
  const headers = { ...req.headers, host: upstreamUrl.host };

  const upstream = http.request(upstreamUrl, {
    method: req.method,
    headers,
  }, (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(res);
  });

  upstream.once('error', (error) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    writeJson(res, 502, {
      ok: false,
      error: `w2mgr is unreachable at ${w2mgrUrl}: ${error.message}`,
    });
  });
  req.pipe(upstream);
}

/**
 * Proxy broker WebSocket upgrades through the pw-dev server.
 *
 * Playwright CDP connects over WebSocket after HTTP JSON discovery. Rewriting
 * the returned `cdpUrl` to `/_pwdev/broker/instances/:id` means this upgrade
 * path must forward raw sockets to the paired broker.
 *
 * @param {{
 *   req: http.IncomingMessage,
 *   socket: import('node:net').Socket,
 *   head: Buffer,
 *   broker: PwDevBrokerPairing,
 * }} options
 */
function proxyBrokerUpgrade({ req, socket, head, broker }) {
  let brokerUrl;
  let upstreamUrl;
  try {
    brokerUrl = broker.resolve();
    upstreamUrl = new URL(proxyBrokerPath(new URL(req.url || '/', 'http://local')), ensureTrailingSlash(brokerUrl));
  } catch (error) {
    socket.write(`HTTP/1.1 ${error.statusCode || 503} Service Unavailable\r\n\r\n`);
    socket.destroy();
    return;
  }

  const upstream = net.connect({
    host: upstreamUrl.hostname,
    port: Number(upstreamUrl.port || 80),
  });

  upstream.once('connect', () => {
    upstream.write(buildUpgradeRequest(req, upstreamUrl));
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.once('error', () => {
    if (!socket.destroyed) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      socket.destroy();
    }
  });

  socket.once('error', () => {
    upstream.destroy();
  });
}

function buildUpgradeRequest(req, upstreamUrl) {
  const lines = [`${req.method} ${upstreamUrl.pathname}${upstreamUrl.search} HTTP/${req.httpVersion}`];
  const rawHeaders = req.rawHeaders || [];
  let wroteHost = false;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (name.toLowerCase() === 'host') {
      lines.push(`Host: ${upstreamUrl.host}`);
      wroteHost = true;
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  if (!wroteHost) lines.push(`Host: ${upstreamUrl.host}`);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

function proxyBrokerPath(requestUrl) {
  const suffix = requestUrl.pathname.slice('/_pwdev/broker'.length);
  return `/_broker${suffix || ''}${requestUrl.search}`;
}

function proxyW2MgrPath(requestUrl) {
  const suffix = requestUrl.pathname.slice('/_pwdev/w2mgr'.length);
  return `/_w2mgr${suffix || ''}${requestUrl.search}`;
}

/**
 * Bridge app-scoped browser lifecycle routes to the broker.
 *
 * The app registry remains the agent-facing source of truth. On start, this
 * helper calls `POST /_broker/start`, saves the returned `cdpUrl` and
 * `instanceId` onto the app's default browser slot or a task-scoped
 * `browserSessions` entry, and returns app, session, and broker payloads. On
 * stop, it calls `POST /_broker/stop` and removes the matching session fields.
 *
 * @param {{
 *   req: http.IncomingMessage,
 *   res: http.ServerResponse,
 *   apps: PwDevAppRegistry,
 *   proxies: PwDevProxyRegistry,
 *   broker: PwDevBrokerPairing,
 *   serverUrl: string,
 *   id: string,
 *   command: string,
 *   writeBody: boolean,
 * }} options
 * @returns {Promise<void>}
 */
async function handleAppBrowserRequest({ req, res, apps, proxies, broker, serverUrl, id, command, writeBody }) {
  const app = apps.get(id);
  if (!app) {
    writeJson(res, 404, { ok: false, error: `Unknown app: ${id}` }, writeBody);
    return;
  }

  if (command === 'status') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end('Method Not Allowed');
      return;
    }
    const brokerUrl = broker.resolve(app.brokerUrl);
    const status = await brokerJson(brokerUrl, '/_broker/status');
    writeJson(res, 200, { ok: true, app, broker: status }, writeBody);
    return;
  }

  if (command === 'start') {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      res.end('Method Not Allowed');
      return;
    }
    const payload = await readJsonBody(req);
    const brokerUrl = broker.resolve(payload.brokerUrl ?? app.brokerUrl);
    const task = payload.task === undefined ? undefined : validateTaskInput(payload.task);
    const slot = resolveBrowserSessionSlot({ app, payload, task });
    const conflict = findBrowserSessionConflict({ app, slot });
    if (conflict) {
      writeJson(res, 409, conflict);
      return;
    }
    const proxy = resolveProxyForBrowserStart({
      proxies,
      proxyId: payload.proxyId ?? app.proxyId,
      proxyForwardId: payload.proxyForwardId ?? app.proxyForwardId,
      proxyServer: payload.proxyServer ?? app.proxyServer,
    });
    const start = await brokerJson(brokerUrl, '/_broker/start', {
      method: 'POST',
      body: omitUndefined({
        profile: slot.profile,
        proxyForwardId: proxy.proxyForwardId,
        proxyServer: proxy.proxyServer,
        proxyBypassList: payload.proxyBypassList,
        ignoreSslErrors: payload.ignoreSslErrors,
        headless: payload.headless,
        resetProfile: payload.resetProfile,
      }),
    });
    const proxiedCdpUrl = rewriteBrokerUrlToServerProxy(start.cdpUrl, serverUrl);
    const activeTask = task ? {
      ...task,
      startedAt: new Date().toISOString(),
    } : undefined;
    const browser = { ...start, cdpUrl: proxiedCdpUrl };
    let updated;
    let session;
    if (slot.taskId) {
      session = makeBrowserSession({
        sessionId: slot.sessionId,
        task,
        activeTask,
        start,
        profile: slot.profile,
        cdpUrl: proxiedCdpUrl,
        proxy,
      });
      updated = apps.update(id, {
        browserSessions: {
          ...(app.browserSessions ?? {}),
          [slot.sessionId]: session,
        },
      });
    } else {
      updated = apps.update(id, {
        cdpUrl: proxiedCdpUrl,
        profile: start.profile,
        proxyId: proxy.proxyId ?? app.proxyId,
        browserInstanceId: start.instanceId,
        proxyForwardId: start.proxyForwardId,
        proxyServer: start.proxyServer,
        browserStartedAt: start.startedAt,
      });
    }
    writeJson(res, 200, omitUndefined({ ok: true, app: updated, session, browser }));
    return;
  }

  if (command === 'stop') {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      res.end('Method Not Allowed');
      return;
    }
    const payload = await readJsonBody(req);
    const brokerUrl = broker.resolve(payload.brokerUrl ?? app.brokerUrl);
    const stopTarget = resolveBrowserStopTarget({ app, payload });
    const instanceId = stopTarget?.browserInstanceId;
    if (!instanceId) {
      writeJson(res, 400, { ok: false, error: `App has no browser instance: ${id}` });
      return;
    }
    const stop = await brokerJson(brokerUrl, '/_broker/stop', {
      method: 'POST',
      body: { instanceId },
    });
    let updated;
    if (stopTarget.taskId) {
      const browserSessions = { ...(app.browserSessions ?? {}) };
      delete browserSessions[stopTarget.sessionId];
      updated = apps.update(id, {
        browserSessions: Object.keys(browserSessions).length ? browserSessions : undefined,
      });
    } else {
      updated = apps.update(id, {
        cdpUrl: undefined,
        browserInstanceId: undefined,
        browserStartedAt: undefined,
        activeTask: undefined,
      });
    }
    writeJson(res, 200, { ok: true, app: updated, session: stopTarget.session, browser: stop });
    return;
  }

  writeJson(res, 404, { ok: false, error: 'Unknown app browser endpoint' }, writeBody);
}

function resolveBrowserSessionSlot({ app, payload, task }) {
  const sessionId = task ? composeBrowserSessionId(app.id, task.id) : undefined;
  const profile = payload.profile !== undefined
    ? requiredString(payload.profile, 'profile')
    : task
      ? sessionId
      : app.profile ?? app.id;
  validateBrowserProfileName(profile, 'profile');
  return {
    taskId: task?.id,
    sessionId,
    profile,
  };
}

function findBrowserSessionConflict({ app, slot }) {
  if (slot.sessionId) {
    const existing = app.browserSessions?.[slot.sessionId];
    if (existing) {
      return {
        ok: false,
        error: 'App already has an active browser session for task',
        appId: app.id,
        sessionId: slot.sessionId,
        taskId: slot.taskId,
        profile: existing.profile,
        browserInstanceId: existing.browserInstanceId,
        activeTask: existing.activeTask,
        session: existing,
      };
    }
  } else if (app.browserInstanceId || app.activeTask) {
    return {
      ok: false,
      error: 'App already has an active browser task',
      appId: app.id,
      browserInstanceId: app.browserInstanceId,
      activeTask: app.activeTask,
    };
  }

  const profileConflict = findActiveBrowserProfile(app, slot.profile);
  if (!profileConflict) return undefined;
  return omitUndefined({
    ok: false,
    error: 'Browser profile already has an active session',
    appId: app.id,
    taskId: profileConflict.taskId,
    profile: slot.profile,
    browserInstanceId: profileConflict.browserInstanceId,
    activeTask: profileConflict.activeTask,
    session: profileConflict.session,
  });
}

function findActiveBrowserProfile(app, profile) {
  if (app.browserInstanceId && app.profile === profile) {
    return {
      browserInstanceId: app.browserInstanceId,
      activeTask: app.activeTask,
    };
  }
  for (const session of Object.values(app.browserSessions ?? {})) {
    if (session.profile === profile) {
      return {
        taskId: session.taskId,
        sessionId: session.sessionId,
        browserInstanceId: session.browserInstanceId,
        activeTask: session.activeTask,
        session,
      };
    }
  }
  return undefined;
}

function makeBrowserSession({ sessionId, task, activeTask, start, profile, cdpUrl, proxy }) {
  return omitUndefined({
    sessionId,
    taskId: task.id,
    profile: start.profile ?? profile,
    cdpUrl,
    browserInstanceId: start.instanceId,
    browserStartedAt: start.startedAt,
    proxyId: proxy.proxyId,
    proxyForwardId: start.proxyForwardId,
    proxyServer: start.proxyServer,
    activeTask,
  });
}

function resolveBrowserStopTarget({ app, payload }) {
  const sessionId = optionalString(payload.sessionId, 'sessionId');
  if (sessionId) {
    const session = app.browserSessions?.[sessionId];
    return session ? { sessionId, taskId: session.taskId, session, browserInstanceId: session.browserInstanceId } : undefined;
  }

  const taskId = payload.taskId !== undefined
    ? requiredString(payload.taskId, 'taskId')
    : payload.task === undefined
      ? undefined
      : validateTaskInput(payload.task).id;
  if (taskId) {
    const session = Object.values(app.browserSessions ?? {}).find((candidate) => candidate.taskId === taskId);
    return session ? { sessionId: session.sessionId, taskId, session, browserInstanceId: session.browserInstanceId } : undefined;
  }

  const instanceId = optionalString(payload.instanceId, 'instanceId');
  if (instanceId) {
    if (app.browserInstanceId === instanceId) {
      return { browserInstanceId: app.browserInstanceId };
    }
    for (const session of Object.values(app.browserSessions ?? {})) {
      if (session.browserInstanceId === instanceId) {
        return { sessionId: session.sessionId, taskId: session.taskId, session, browserInstanceId: session.browserInstanceId };
      }
    }
    return undefined;
  }

  return app.browserInstanceId ? { browserInstanceId: app.browserInstanceId } : undefined;
}

function composeBrowserSessionId(appId, taskId) {
  return `${appId}__${taskId}`;
}

function validateBrowserProfileName(profile, name) {
  if (!/^[A-Za-z0-9._-]+$/.test(profile)) {
    throwValidationError(`${name} must contain only letters, numbers, dot, underscore, and dash`);
  }
  if (profile === '.' || profile === '..') {
    throwValidationError(`${name} cannot be "." or ".."`);
  }
}

/**
 * Fetch JSON from the broker and convert non-2xx responses to route errors.
 *
 * @param {string} brokerUrl Broker base URL, for example `http://127.0.0.1:18080`.
 * @param {string} pathname Broker API path.
 * @param {{ method?: string, body?: unknown }=} options Request options.
 * @returns {Promise<Record<string, unknown>>}
 */
async function brokerJson(brokerUrl, pathname, options = {}) {
  const url = new URL(pathname, ensureTrailingSlash(brokerUrl));
  const requestBody = options.body === undefined ? undefined : JSON.stringify(options.body);
  const { statusCode, text } = await new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: options.method ?? 'GET',
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
        resolve({ statusCode: response.statusCode || 0, text: responseText });
      });
    });
    request.once('error', (cause) => {
      const error = new Error(`Broker is unreachable at ${brokerUrl}: ${cause?.message || 'request failed'}`);
      error.statusCode = 503;
      reject(error);
    });
    request.end(requestBody);
  });
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { ok: false, error: text };
  }
  if (statusCode < 200 || statusCode >= 300) {
    const error = new Error(payload.error || `Broker request failed: ${statusCode}`);
    error.statusCode = statusCode || 502;
    throw error;
  }
  return payload;
}

/**
 * Create server-level broker pairing.
 *
 * @param {{ brokerUrl?: string }} options
 * @returns {PwDevBrokerPairing}
 */
function createBrokerPairing({ brokerUrl } = {}) {
  const configuredUrl = normalizeBrokerUrl(brokerUrl ?? DEFAULT_BROKER_URL);
  const usesDefault = !brokerUrl;
  return {
    summary() {
      return omitUndefined({ configured: true, url: configuredUrl, default: usesDefault || undefined });
    },
    async status() {
      try {
        const status = await brokerJson(configuredUrl, '/_broker/status');
        return omitUndefined({ configured: true, reachable: true, url: configuredUrl, default: usesDefault || undefined, status });
      } catch (error) {
        return omitUndefined({
          configured: true,
          reachable: false,
          url: configuredUrl,
          default: usesDefault || undefined,
          error: error?.message || 'Broker is unreachable',
        });
      }
    },
    resolve(overrideUrl) {
      return overrideUrl ? normalizeBrokerUrl(overrideUrl) : configuredUrl;
    },
  };
}

function normalizeBrokerUrl(value) {
  return normalizeHttpUrl(value, 'brokerUrl');
}

function normalizeHttpUrl(value, name) {
  const url = new URL(value);
  if (url.protocol !== 'http:') {
    throw new Error(`${name} must use http://`);
  }
  return url.toString().replace(/\/$/, '');
}

function rewriteBrokerUrlToServerProxy(rawUrl, serverUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return rawUrl;
  const source = new URL(rawUrl);
  const target = new URL(serverUrl);
  source.protocol = target.protocol;
  source.host = target.host;
  if (source.pathname.startsWith('/_broker')) {
    source.pathname = `/_pwdev/broker${source.pathname.slice('/_broker'.length)}`;
  }
  return source.toString();
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function writeBrokerError(res, error) {
  if (res.headersSent) {
    res.destroy(error);
    return;
  }
  writeJson(res, error?.statusCode || 502, {
    ok: false,
    error: error?.message || 'Broker request failed',
  });
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

function writeJson(res, statusCode, payload, writeBody = true) {
  const body = Buffer.from(JSON.stringify(payload));
  writeResponse(res, statusCode, 'application/json; charset=utf-8', body, writeBody);
}

function writeText(res, statusCode, text, writeBody = true) {
  const body = Buffer.from(text);
  writeResponse(res, statusCode, 'text/plain; charset=utf-8', body, writeBody);
}

function writeTypedText(res, statusCode, contentType, text, writeBody = true) {
  const body = Buffer.from(text);
  writeResponse(res, statusCode, contentType, body, writeBody);
}

function writeResponse(res, statusCode, contentType, body, writeBody = true) {
  res.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': body.length,
  });
  res.end(writeBody ? body : undefined);
}

function defaultAppId(worktree) {
  return path.basename(worktree) || 'pw-dev-app';
}

function validateMetadata(metadata) {
  const validated = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) {
      validated[key] = undefined;
      continue;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${key} must be a non-empty string`);
    }
    validated[key] = value;
  }
  return validated;
}

/**
 * Validate and normalize a registry app payload.
 *
 * Registration is deliberately metadata-only: pw-dev does not start the app
 * devserver here. Browser ownership is handled later through app-scoped browser
 * endpoints that call the broker.
 *
 * @param {Record<string, unknown>} rawApp App registration body.
 * @returns {PwDevAppManifest}
 */
function validateAppRegistration(rawApp) {
  if (!rawApp || typeof rawApp !== 'object') {
    throw new Error('app registration must be an object');
  }

  const id = rawApp.id;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('id must be a non-empty string');
  }

  const app = {
    ok: true,
    id,
    name: optionalString(rawApp.name, 'name'),
    root: optionalPath(rawApp.root, 'root'),
    worktree: optionalPath(rawApp.worktree, 'worktree'),
    branch: optionalString(rawApp.branch, 'branch'),
    appUrl: optionalString(rawApp.appUrl, 'appUrl'),
    devserver: rawApp.devserver === undefined ? undefined : validateDevserverCommand(rawApp.devserver),
    engine: rawApp.engine === undefined ? undefined : validateAppEngine(rawApp.engine),
    accounts: rawApp.accounts === undefined ? undefined : validateAccounts(rawApp.accounts),
    brokerUrl: optionalString(rawApp.brokerUrl, 'brokerUrl'),
    cdpUrl: optionalString(rawApp.cdpUrl, 'cdpUrl'),
    profile: optionalString(rawApp.profile, 'profile'),
    proxyId: optionalString(rawApp.proxyId, 'proxyId'),
    proxyForwardId: optionalString(rawApp.proxyForwardId, 'proxyForwardId'),
    proxyServer: optionalString(rawApp.proxyServer, 'proxyServer'),
    browserInstanceId: optionalString(rawApp.browserInstanceId, 'browserInstanceId'),
    browserStartedAt: optionalString(rawApp.browserStartedAt, 'browserStartedAt'),
    activeTask: rawApp.activeTask === undefined ? undefined : validateActiveTask(rawApp.activeTask),
    browserSessions: rawApp.browserSessions === undefined ? undefined : validateBrowserSessions(rawApp.browserSessions),
    serverUrl: optionalString(rawApp.serverUrl, 'serverUrl'),
    createdAt: optionalString(rawApp.createdAt, 'createdAt'),
    updatedAt: optionalString(rawApp.updatedAt, 'updatedAt'),
  };
  return omitUndefined(app);
}

/**
 * Validate and normalize a reusable proxy registration payload.
 *
 * @param {Record<string, unknown>} rawProxy Proxy registration body.
 * @returns {PwDevProxyRecord}
 */
function validateProxyRegistration(rawProxy) {
  if (!rawProxy || typeof rawProxy !== 'object') {
    throwValidationError('proxy registration must be an object');
  }

  const proxy = {
    id: requiredString(rawProxy.id, 'id'),
    kind: optionalString(rawProxy.kind, 'kind'),
    name: optionalString(rawProxy.name, 'name'),
    proxyUrl: optionalString(rawProxy.proxyUrl, 'proxyUrl'),
    brokerProxyForwardId: optionalString(rawProxy.brokerProxyForwardId, 'brokerProxyForwardId'),
    createdAt: optionalString(rawProxy.createdAt, 'createdAt'),
    updatedAt: optionalString(rawProxy.updatedAt, 'updatedAt'),
  };

  if (!proxy.proxyUrl && !proxy.brokerProxyForwardId) {
    throwValidationError('proxyUrl or brokerProxyForwardId is required');
  }
  if (proxy.proxyUrl && proxy.brokerProxyForwardId) {
    throwValidationError('proxyUrl and brokerProxyForwardId are mutually exclusive');
  }
  if (proxy.proxyUrl) validateHttpUrl(proxy.proxyUrl, 'proxyUrl');

  return omitUndefined(proxy);
}

function resolveProxyForBrowserStart({ proxies, proxyId, proxyForwardId, proxyServer }) {
  if (proxyForwardId && proxyServer) {
    throwValidationError('proxyForwardId and proxyServer are mutually exclusive');
  }
  if ((proxyForwardId || proxyServer) && proxyId) {
    return {
      proxyId: undefined,
      proxyForwardId,
      proxyServer,
    };
  }
  if (proxyForwardId || proxyServer || !proxyId) {
    return {
      proxyId,
      proxyForwardId,
      proxyServer,
    };
  }

  const proxy = proxies.get(proxyId);
  if (!proxy) {
    const error = new Error(`Unknown proxy: ${proxyId}`);
    error.statusCode = 404;
    throw error;
  }
  if (proxy.brokerProxyForwardId && proxy.proxyUrl) {
    throwValidationError(`Proxy has both brokerProxyForwardId and proxyUrl: ${proxyId}`);
  }
  return {
    proxyId,
    proxyForwardId: proxy.brokerProxyForwardId,
    proxyServer: proxy.proxyUrl,
  };
}

/**
 * Validate named account credentials.
 *
 * @param {unknown} rawAccounts Accounts payload.
 * @returns {Record<string, PwDevAccountCredentials>}
 */
function validateAccounts(rawAccounts) {
  if (!rawAccounts || typeof rawAccounts !== 'object' || Array.isArray(rawAccounts)) {
    throwValidationError('accounts must be an object');
  }
  const accounts = {};
  for (const [name, account] of Object.entries(rawAccounts)) {
    if (!account || typeof account !== 'object' || Array.isArray(account)) {
      throwValidationError(`accounts.${name} must be an object`);
    }
    accounts[name] = omitUndefined({
      usr: requiredString(account.usr, `accounts.${name}.usr`),
      pwd: requiredString(account.pwd, `accounts.${name}.pwd`),
      label: optionalString(account.label, `accounts.${name}.label`),
    });
  }
  return accounts;
}

/**
 * Validate app devserver command metadata.
 *
 * @param {unknown} rawDevserver Devserver metadata payload.
 * @returns {PwDevDevserverCommand}
 */
function validateDevserverCommand(rawDevserver) {
  if (!rawDevserver || typeof rawDevserver !== 'object') {
    throwValidationError('devserver must be an object');
  }
  return omitUndefined({
    command: requiredString(rawDevserver.command, 'devserver.command'),
    args: rawDevserver.args === undefined ? undefined : validateStringArray(rawDevserver.args, 'devserver.args'),
    cwd: optionalPath(rawDevserver.cwd, 'devserver.cwd'),
    env: rawDevserver.env === undefined ? undefined : validateStringRecord(rawDevserver.env, 'devserver.env'),
  });
}

/**
 * Validate app runtime engine metadata.
 *
 * @param {unknown} rawEngine Engine metadata payload.
 * @returns {PwDevAppEngine}
 */
function validateAppEngine(rawEngine) {
  if (!rawEngine || typeof rawEngine !== 'object') {
    throwValidationError('engine must be an object');
  }
  return omitUndefined({
    name: optionalString(rawEngine.name, 'engine.name'),
    version: optionalString(rawEngine.version, 'engine.version'),
    requirement: optionalString(rawEngine.requirement, 'engine.requirement'),
  });
}

/**
 * Validate task metadata accepted by browser start.
 *
 * @param {unknown} rawTask Task payload.
 * @returns {PwDevTaskInput}
 */
function validateTaskInput(rawTask) {
  if (!rawTask || typeof rawTask !== 'object') {
    throwValidationError('task must be an object');
  }
  return omitUndefined({
    id: requiredString(rawTask.id, 'task.id'),
    label: optionalString(rawTask.label, 'task.label'),
    owner: optionalString(rawTask.owner, 'task.owner'),
  });
}

function validateActiveTask(rawTask) {
  const task = validateTaskInput(rawTask);
  return {
    ...task,
    startedAt: requiredString(rawTask.startedAt, 'activeTask.startedAt'),
  };
}

function validateBrowserSessions(rawSessions) {
  if (!rawSessions || typeof rawSessions !== 'object' || Array.isArray(rawSessions)) {
    throwValidationError('browserSessions must be an object');
  }
  return Object.fromEntries(Object.entries(rawSessions).map(([id, rawSession]) => [
    id,
    validateBrowserSession(rawSession, `browserSessions.${id}`),
  ]));
}

function validateBrowserSession(rawSession, name) {
  if (!rawSession || typeof rawSession !== 'object' || Array.isArray(rawSession)) {
    throwValidationError(`${name} must be an object`);
  }
  return omitUndefined({
    sessionId: requiredString(rawSession.sessionId, `${name}.sessionId`),
    taskId: requiredString(rawSession.taskId, `${name}.taskId`),
    profile: requiredString(rawSession.profile, `${name}.profile`),
    cdpUrl: requiredString(rawSession.cdpUrl, `${name}.cdpUrl`),
    browserInstanceId: requiredString(rawSession.browserInstanceId, `${name}.browserInstanceId`),
    browserStartedAt: optionalString(rawSession.browserStartedAt, `${name}.browserStartedAt`),
    proxyId: optionalString(rawSession.proxyId, `${name}.proxyId`),
    proxyForwardId: optionalString(rawSession.proxyForwardId, `${name}.proxyForwardId`),
    proxyServer: optionalString(rawSession.proxyServer, `${name}.proxyServer`),
    activeTask: validateActiveTask(rawSession.activeTask),
  });
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throwValidationError(`${name} must be a non-empty string`);
  }
  return value;
}

function validateStringArray(value, name) {
  if (!Array.isArray(value)) {
    throwValidationError(`${name} must be an array of strings`);
  }
  return value.map((item, index) => requiredString(item, `${name}[${index}]`));
}

function validateStringRecord(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwValidationError(`${name} must be an object with string values`);
  }
  const validated = {};
  for (const [key, child] of Object.entries(value)) {
    validated[key] = requiredString(child, `${name}.${key}`);
  }
  return validated;
}

function validateHttpUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throwValidationError(`${name} must be a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throwValidationError(`${name} must use http:// or https://`);
  }
}

function throwValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

function optionalPath(value, name) {
  const stringValue = optionalString(value, name);
  return stringValue === undefined ? undefined : path.resolve(stringValue);
}

function optionalString(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

function requestBaseUrl(req) {
  const host = req.headers.host;
  const encrypted = Boolean(req.socket.encrypted);
  return `${encrypted ? 'https' : 'http'}://${host}`;
}

function pwDevInstructions(serverUrl) {
  return `# pw-dev agent instructions

Use this server as the control plane for app discovery, browser lifecycle, and
broker-proxied CDP. Agents should not need the broker URL directly.

## Discover server and broker state

\`\`\`js
const status = await fetch('${serverUrl}/_pwdev/status')
  .then((response) => response.json());

if (!status.broker?.configured) {
  throw new Error('pw-dev broker status is unavailable');
}

if (status.broker.reachable === false) {
  throw new Error(\`pw-dev broker is unreachable: \${status.broker.error}\`);
}
\`\`\`

## List and select apps

\`\`\`js
const { apps } = await fetch('${serverUrl}/_pwdev/apps')
  .then((response) => response.json());

const app = apps.find((candidate) => candidate.id === 'checkout-tax');
\`\`\`

## Register an app

\`\`\`js
await fetch('${serverUrl}/_pwdev/proxies', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    id: 'whistle-main',
    kind: 'whistle',
    name: 'Shared Whistle',
    proxyUrl: 'http://127.0.0.1:8899',
  }),
});

await fetch('${serverUrl}/_pwdev/apps', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    id: 'fortisase-dev',
    appUrl: 'https://dev.fortisase-sovereign.com',
    devserver: {
      command: 'npm',
      args: ['run', 'dev'],
      cwd: '/home/me/work/fortisase',
    },
    engine: {
      name: 'node',
      version: process.version,
      requirement: '>=18',
    },
    accounts: {
      login: {
        usr: 'xxx',
        pwd: 'xxx',
      },
    },
    profile: 'fortisase-dev',
    proxyId: 'whistle-main',
  }),
});
\`\`\`

Only register non-production test accounts in \`accounts\`. Do not put
production accounts, personal credentials, or sensitive tokens in app metadata.

## Start browser and attach Playwright

\`\`\`js
const started = await fetch('${serverUrl}/_pwdev/apps/checkout-tax/browser/start', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    ignoreSslErrors: true,
    task: {
      id: 'smoke-login-20260629',
      label: 'Smoke login flow',
      owner: 'codex',
    },
  }),
}).then((response) => response.json());

const manifest = await fetch('${serverUrl}/_pwdev/apps/checkout-tax/manifest')
  .then((response) => response.json());

const cdpUrl = started.session?.cdpUrl ?? manifest.cdpUrl;
const browser = await chromium.connectOverCDP(cdpUrl);
const context = browser.contexts()[0];
const page = context.pages()[0] ?? await context.newPage();
await page.goto(manifest.appUrl);
\`\`\`

The default manifest \`cdpUrl\` and task session \`cdpUrl\` values point at
\`/_pwdev/broker/*\`, which proxies broker HTTP and WebSocket traffic through
this server.

## Stop browser

\`\`\`js
await fetch('${serverUrl}/_pwdev/apps/checkout-tax/browser/stop', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ taskId: 'smoke-login-20260629' }),
});
\`\`\`

## Start registered app/proxy processes with w2mgr

If \`pw-dev w2mgr\` is running, use the server-proxied API. Agents do not need
the w2mgr port directly.
Whistle proxy ports are allocated from \`8888-8899\`; if a registered proxy
port conflicts, w2mgr chooses the next free pool port and updates the proxy
registration.

\`\`\`js
await fetch('${serverUrl}/_pwdev/w2mgr/proxies/whistle-main/start', {
  method: 'POST',
});

await fetch('${serverUrl}/_pwdev/w2mgr/apps/fortisase-dev/start', {
  method: 'POST',
});

const w2mgrStatus = await fetch('${serverUrl}/_pwdev/w2mgr/status')
  .then((response) => response.json());
\`\`\`

## Endpoints

\`\`\`text
GET    /_pwdev/status
GET    /_pwdev/instructions
GET    /_pwdev/client.js
GET    /_pwdev/proxies
POST   /_pwdev/proxies
GET    /_pwdev/proxies/:id
DELETE /_pwdev/proxies/:id
GET    /_pwdev/apps
POST   /_pwdev/apps
GET    /_pwdev/apps/:id
DELETE /_pwdev/apps/:id
GET    /_pwdev/apps/:id/manifest
GET    /_pwdev/apps/:id/browser/status
POST   /_pwdev/apps/:id/browser/start
POST   /_pwdev/apps/:id/browser/stop
ANY    /_pwdev/broker/*
GET    /_pwdev/w2mgr/status
POST   /_pwdev/w2mgr/sync
POST   /_pwdev/w2mgr/apps/:id/start
POST   /_pwdev/w2mgr/apps/:id/stop
POST   /_pwdev/w2mgr/proxies/:id/start
POST   /_pwdev/w2mgr/proxies/:id/stop
POST   /_pwdev/w2mgr/start-all
POST   /_pwdev/w2mgr/stop-all
\`\`\`

Helper source is available from:

\`\`\`text
GET /_pwdev/client.js
\`\`\`
`;
}

function pwDevClientSource(serverUrl) {
  return `export async function loadPwDevStatus({ serverUrl = '${serverUrl}' } = {}) {
  const response = await fetch(\`\${serverUrl}/_pwdev/status\`);
  if (!response.ok) {
    throw new Error(\`pw-dev status failed: \${response.status} \${await response.text()}\`);
  }
  return response.json();
}

export async function assertPwDevReady({ serverUrl = '${serverUrl}' } = {}) {
  const status = await loadPwDevStatus({ serverUrl });
  if (!status.broker?.configured) {
    throw new Error('pw-dev broker status is unavailable');
  }
  if (status.broker.reachable === false) {
    throw new Error(\`pw-dev broker is unreachable: \${status.broker.error}\`);
  }
  return status;
}

export async function listPwDevApps({ serverUrl = '${serverUrl}' } = {}) {
  const response = await fetch(\`\${serverUrl}/_pwdev/apps\`);
  if (!response.ok) {
    throw new Error(\`pw-dev apps failed: \${response.status} \${await response.text()}\`);
  }
  return response.json();
}

export async function listPwDevProxies({ serverUrl = '${serverUrl}' } = {}) {
  const response = await fetch(\`\${serverUrl}/_pwdev/proxies\`);
  if (!response.ok) {
    throw new Error(\`pw-dev proxies failed: \${response.status} \${await response.text()}\`);
  }
  return response.json();
}

export async function registerPwDevProxy(proxy, { serverUrl = '${serverUrl}' } = {}) {
  const response = await fetch(\`\${serverUrl}/_pwdev/proxies\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(proxy),
  });
  if (!response.ok) {
    throw new Error(\`pw-dev proxy registration failed: \${response.status} \${await response.text()}\`);
  }
  return response.json();
}

export async function registerPwDevApp(app, { serverUrl = '${serverUrl}' } = {}) {
  const response = await fetch(\`\${serverUrl}/_pwdev/apps\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(app),
  });
  if (!response.ok) {
    throw new Error(\`pw-dev app registration failed: \${response.status} \${await response.text()}\`);
  }
  return response.json();
}

export async function loadPwDevW2MgrStatus({ serverUrl = '${serverUrl}' } = {}) {
  const response = await fetch(\`\${serverUrl}/_pwdev/w2mgr/status\`);
  if (!response.ok) {
    throw new Error(\`pw-dev w2mgr status failed: \${response.status} \${await response.text()}\`);
  }
  return response.json();
}

export async function startPwDevW2MgrApp(appId, { serverUrl = '${serverUrl}' } = {}) {
  const response = await fetch(\`\${serverUrl}/_pwdev/w2mgr/apps/\${encodeURIComponent(appId)}/start\`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(\`pw-dev w2mgr app start failed: \${response.status} \${await response.text()}\`);
  }
  return response.json();
}

export async function stopPwDevW2MgrApp(appId, { serverUrl = '${serverUrl}' } = {}) {
  const response = await fetch(\`\${serverUrl}/_pwdev/w2mgr/apps/\${encodeURIComponent(appId)}/stop\`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(\`pw-dev w2mgr app stop failed: \${response.status} \${await response.text()}\`);
  }
  return response.json();
}

export async function startPwDevW2MgrProxy(proxyId, { serverUrl = '${serverUrl}' } = {}) {
  const response = await fetch(\`\${serverUrl}/_pwdev/w2mgr/proxies/\${encodeURIComponent(proxyId)}/start\`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(\`pw-dev w2mgr proxy start failed: \${response.status} \${await response.text()}\`);
  }
  return response.json();
}

export async function stopPwDevW2MgrProxy(proxyId, { serverUrl = '${serverUrl}' } = {}) {
  const response = await fetch(\`\${serverUrl}/_pwdev/w2mgr/proxies/\${encodeURIComponent(proxyId)}/stop\`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(\`pw-dev w2mgr proxy stop failed: \${response.status} \${await response.text()}\`);
  }
  return response.json();
}

export async function loadPwDevManifest({ serverUrl = '${serverUrl}', appId } = {}) {
  const path = appId
    ? \`/_pwdev/apps/\${encodeURIComponent(appId)}/manifest\`
    : '/_pwdev/manifest';
  const response = await fetch(\`\${serverUrl}\${path}\`);
  if (!response.ok) {
    throw new Error(\`pw-dev manifest failed: \${response.status} \${await response.text()}\`);
  }
  return response.json();
}

export async function startPwDevBrowser({
  serverUrl = '${serverUrl}',
  appId,
  ignoreSslErrors,
  headless,
  resetProfile,
  profile,
  proxyId,
  proxyForwardId,
  proxyServer,
  proxyBypassList,
  task,
} = {}) {
  if (!appId) throw new Error('startPwDevBrowser requires appId');
  const response = await fetch(\`\${serverUrl}/_pwdev/apps/\${encodeURIComponent(appId)}/browser/start\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ignoreSslErrors,
      headless,
      resetProfile,
      profile,
      proxyId,
      proxyForwardId,
      proxyServer,
      proxyBypassList,
      task,
    }),
  });
  if (!response.ok) {
    throw new Error(\`pw-dev browser start failed: \${response.status} \${await response.text()}\`);
  }
  return response.json();
}

export async function stopPwDevBrowser({ serverUrl = '${serverUrl}', appId, instanceId, taskId, task } = {}) {
  if (!appId) throw new Error('stopPwDevBrowser requires appId');
  const response = await fetch(\`\${serverUrl}/_pwdev/apps/\${encodeURIComponent(appId)}/browser/stop\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId, taskId, task }),
  });
  if (!response.ok) {
    throw new Error(\`pw-dev browser stop failed: \${response.status} \${await response.text()}\`);
  }
  return response.json();
}

export async function connectPwDev({ serverUrl = '${serverUrl}', appId, chromium, startBrowser = true } = {}) {
  if (!chromium) {
    throw new Error('connectPwDev requires a Playwright chromium object');
  }

  await assertPwDevReady({ serverUrl });

  if (appId && startBrowser) {
    await startPwDevBrowser({ serverUrl, appId });
  }

  const manifest = await loadPwDevManifest({ serverUrl, appId });
  if (!manifest.cdpUrl) {
    throw new Error('pw-dev manifest does not include cdpUrl');
  }

  const browser = await chromium.connectOverCDP(manifest.cdpUrl);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.newPage();

  return { manifest, browser, context, page };
}
`;
}
