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
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SERVER_PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PROXY_PACKAGE_ROOT = path.resolve(SERVER_PACKAGE_ROOT, '..', 'proxy');
const BROKER_PACKAGE_ROOT = path.resolve(SERVER_PACKAGE_ROOT, '..', 'cdp-broker');

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
const DEFAULT_PROXY_MANAGER_URL = 'http://127.0.0.1:9697';

/**
 * Options for `startPwDevServer`.
 *
 * The scalar app fields seed the server's own root manifest. App registry
 * entries are registered through `POST /_pwdev/apps`, unless
 * `registerDefaultApp` is explicitly enabled.
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
 * @property {string=} proxyManagerUrl Optional proxy manager base URL proxied under `/_pwdev/proxy/*`. Defaults to `http://127.0.0.1:9697`.
 * @property {() => Promise<unknown>=} ensureProxyManager Lazily starts a server-owned proxy manager before proxy-manager requests.
 * @property {string=} cdpUrl Optional Playwright CDP URL for direct browser attachment.
 * @property {string=} proxyId Optional proxy registry id for the app.
 * @property {string=} proxyForwardId Optional broker-managed proxy forward id, for example a Whistle tunnel.
 * @property {string=} proxyServer Optional Chrome proxy server URL.
 * @property {string=} appRegistryFile Durable app registry JSON path. Defaults to `<worktree>/.pw-dev/apps.json`.
 * @property {string=} proxyRegistryFile Durable proxy registry JSON path. Defaults to `<worktree>/.pw-dev/proxies.json`.
 * @property {string=} browserRegistryFile Durable browser template JSON path. Defaults to `<worktree>/.pw-dev/browsers.json`.
 * @property {boolean=} registerDefaultApp Register the root manifest in `/_pwdev/apps`. Defaults to false.
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
 * @property {string=} readme App-specific agent instructions, such as devserver operation and environment requirements.
 * @property {Record<string, PwDevAccountCredentials>=} accounts Named credentials for agent-assisted login.
 * @property {string=} brokerUrl Advanced per-app broker override. Normal app registration should not set this.
 * @property {string=} cdpUrl Playwright CDP URL for direct browser attachment.
 * @property {string=} networkId Broker network id associated with this app.
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
 * @property {string=} appId App id this managed proxy is attached to.
 * @property {string=} taskId Agent task/test/verification id associated with this proxy.
 * @property {string=} owner Agent/user/tool that owns this proxy.
 * @property {string=} purpose Short reason this proxy exists.
 * @property {string[]=} labels Agent-defined labels for filtering and cleanup.
 * @property {string=} proxyUrl Direct Chrome proxy server URL, for example `http://127.0.0.1:8899`.
 * @property {string=} guiUrl Whistle GUI URL, for example `http://127.0.0.1:9800`.
 * @property {string=} storageDir Whistle `-S` profile directory used for recovery.
 * @property {number=} proxyPort Allocated Whistle proxy port.
 * @property {number=} uiPort Allocated Whistle GUI port.
 * @property {number=} pid Current Whistle process id when managed.
 * @property {string=} brokerProxyForwardId Broker-managed proxy forward id.
 * @property {string=} rulesetFile Local ruleset handoff file used to create this proxy.
 * @property {{ defaultRuleset: string, overrideRuleset: string, effectiveRuleset: string, version: number, updatedAt: string }=} rules Managed live rules state for proxies created by `pw-dev proxy`.
 * @property {boolean=} managed True when created by `pw-dev proxy`.
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
 * Browser session metadata managed by the server.
 *
 * @typedef {object} PwDevBrowserSession
 * @property {string} sessionId Stable session id.
 * @property {string} appId App that owns this session.
 * @property {'default'|'task'} scope Session scope for app lifecycle compatibility.
 * @property {string=} taskId Task id that owns the session when `scope === "task"`.
 * @property {PwDevActiveTask=} activeTask Task metadata that owns the session.
 * @property {string} profile Broker profile used by the session.
 * @property {string} cdpUrl Server-proxied CDP URL.
 * @property {string} brokerUrl Broker base URL used for this session.
 * @property {string} browserInstanceId Broker instance id for the Chrome process.
 * @property {string=} browserStartedAt ISO timestamp returned by the broker.
 * @property {string=} networkId Broker network id associated with the session.
 * @property {string=} proxyId Reusable proxy registry id associated with the session.
 * @property {string=} proxyForwardId Broker proxy-forward id associated with the session.
 * @property {string=} proxyServer Explicit Chrome proxy server URL associated with the session.
 */

/**
 * Mutable session registry interface used by browser lifecycle routes.
 *
 * @typedef {object} PwDevSessionRegistry
 * @property {() => PwDevBrowserSession[]} list Returns known sessions sorted by id.
 * @property {(id: string) => (PwDevBrowserSession | undefined)} get Returns one session by id.
 * @property {(rawSession: Record<string, unknown>) => PwDevBrowserSession} upsert Creates or replaces session metadata by id.
 * @property {(id: string, patch: Record<string, unknown>) => (PwDevBrowserSession | undefined)} update Applies a partial patch; `undefined` deletes optional fields.
 * @property {(id: string) => boolean} delete Removes a session by id.
 * @property {(appId: string) => PwDevBrowserSession[]} listByApp Returns sessions owned by one app.
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
 * @property {string=} profile Broker profile override. Defaults to the app id for a default session and `<app-id>__<task-id>` for a task session.
 * @property {string=} networkId Broker network id. Mutually exclusive with proxy options.
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
    proxyId: options.proxyId,
    proxyForwardId: options.proxyForwardId,
    proxyServer: options.proxyServer,
  });
  const startedAt = new Date().toISOString();
  const broker = createBrokerPairing({ brokerUrl: options.brokerUrl });
  const proxyManagerUrl = normalizeHttpUrl(options.proxyManagerUrl ?? DEFAULT_PROXY_MANAGER_URL, 'proxyManagerUrl');
  const appRegistryFile = path.resolve(options.appRegistryFile ?? path.join(worktree, '.pw-dev', 'apps.json'));
  const apps = createAppRegistry(loadPersistedApps(appRegistryFile), {
    persist: (registeredApps) => persistApps(appRegistryFile, registeredApps),
  });
  const browserRegistryFile = path.resolve(options.browserRegistryFile ?? path.join(worktree, '.pw-dev', 'browsers.json'));
  const browsers = createBrowserRegistry(loadPersistedBrowsers(browserRegistryFile), {
    persist: (registeredBrowsers) => persistRegistryFile(browserRegistryFile, { version: 1, browsers: registeredBrowsers }),
  });
  const proxyRegistryFile = path.resolve(options.proxyRegistryFile ?? path.join(worktree, '.pw-dev', 'proxies.json'));
  const proxies = createProxyRegistry(loadPersistedProxies(proxyRegistryFile), {
    persist: (registeredProxies) => persistProxies(proxyRegistryFile, registeredProxies),
  });
  const sessions = createSessionRegistry();
  let origin;

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url?.startsWith('/_pwdev/')) {
        await handlePwDevRequest({ req, res, root, worktree, origin, startedAt, metadata, apps, browsers, proxies, sessions, broker, proxyManagerUrl, ensureProxyManager: options.ensureProxyManager });
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
  if (options.registerDefaultApp) {
    apps.upsert(buildManifest({ root, worktree, origin, metadata }));
  }

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
 * - `GET /_pwdev/env`
 * - `GET /_pwdev/instructions`
 * - `GET /_pwdev/openapi.json`
 * - `GET /_pwdev/openapi/*`
 * - `GET /_pwdev/delegates`
 * - `GET /_pwdev/delegates/proxy/openapi/*`
 * - `GET /_pwdev/api`
 * - `GET /_pwdev/client.js`
 * - `ANY /_pwdev/broker/*`
 * - `ANY /_pwdev/proxy/*`
 * - `GET|POST /_pwdev/apps`
 * - `GET|DELETE /_pwdev/apps/:id`
 * - `GET /_pwdev/apps/:id/manifest`
 * - `GET|POST /_pwdev/browsers`
 * - `GET|DELETE /_pwdev/browsers/:id`
 * - `POST /_pwdev/browsers/:id/start`
 * - `POST /_pwdev/browsers/:id/stop`
 * - `GET|POST /_pwdev/proxies`
 * - `GET|DELETE /_pwdev/proxies/:id`
 * - `GET /_pwdev/proxies/:id/traffic`
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
 *   sessions: PwDevSessionRegistry,
 *   broker: PwDevBrokerPairing,
 *   proxyManagerUrl: string,
 *   ensureProxyManager?: () => Promise<unknown>,
 * }} options
 * @returns {Promise<void>}
 */
export async function handlePwDevRequest({ req, res, root, worktree, origin, startedAt, metadata, apps, browsers, proxies, sessions, broker, proxyManagerUrl, ensureProxyManager }) {
  const requestUrl = new URL(req.url || '/', 'http://local');
  const serverUrl = origin ?? requestBaseUrl(req);
  const manifest = buildManifest({ root, worktree, origin: serverUrl, metadata });
  const writeBody = req.method !== 'HEAD';

  if (requestUrl.pathname === '/_pwdev/openapi.json' || requestUrl.pathname.startsWith('/_pwdev/openapi/')) {
    handleOpenApiRequest({ req, res, requestUrl, serverUrl, writeBody });
    return;
  }

  if (requestUrl.pathname === '/_pwdev/delegates') {
    writeJson(res, 200, pwDevDelegates(serverUrl, proxyManagerUrl, broker.summary()), writeBody);
    return;
  }

  if (requestUrl.pathname === '/_pwdev/delegates/proxy/instructions') {
    writeTypedText(res, 200, 'text/markdown; charset=utf-8', proxyDelegateInstructions(serverUrl), writeBody);
    return;
  }

  if (requestUrl.pathname === '/_pwdev/delegates/broker/instructions') {
    writeTypedText(res, 200, 'text/markdown; charset=utf-8', brokerDelegateInstructions(serverUrl), writeBody);
    return;
  }

  if (requestUrl.pathname === '/_pwdev/delegates/proxy/openapi.json' || requestUrl.pathname.startsWith('/_pwdev/delegates/proxy/openapi/')) {
    handleProxyDelegateOpenApiRequest({ req, res, requestUrl, serverUrl, writeBody });
    return;
  }

  if (requestUrl.pathname === '/_pwdev/delegates/broker/openapi.json') {
    handleBrokerDelegateOpenApiRequest({ req, res, writeBody });
    return;
  }

  if (requestUrl.pathname.startsWith('/_pwdev/broker')) {
    await proxyBrokerHttpRequest({ req, res, requestUrl, broker });
    return;
  }

  if (requestUrl.pathname.startsWith('/_pwdev/proxy')) {
    if (ensureProxyManager) await ensureProxyManager();
    await proxyProxyManagerHttpRequest({ req, res, requestUrl, proxyManagerUrl });
    return;
  }

  if (requestUrl.pathname === '/_pwdev/browsers' || requestUrl.pathname.startsWith('/_pwdev/browsers/')) {
    await handleBrowserTemplatesRequest({ req, res, requestUrl, apps, browsers, proxies, sessions, broker, serverUrl, writeBody });
    return;
  }

  if (requestUrl.pathname.startsWith('/_pwdev/apps')) {
    await handleAppsRequest({ req, res, requestUrl, apps, proxies, sessions, broker, serverUrl, writeBody });
    return;
  }

  if (requestUrl.pathname.startsWith('/_pwdev/sessions')) {
    await handleSessionsRequest({ req, res, requestUrl, apps, sessions, broker, serverUrl, writeBody });
    return;
  }

  if (requestUrl.pathname.startsWith('/_pwdev/proxies')) {
    await handleProxiesRequest({ req, res, requestUrl, apps, proxies, proxyManagerUrl, writeBody });
    return;
  }

  if (requestUrl.pathname === '/_pwdev/api' || requestUrl.pathname.startsWith('/_pwdev/api/')) {
    await handleApiRequest({ req, res, requestUrl, serverUrl, writeBody });
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
      proxy: { url: proxyManagerUrl },
      proxies: proxies.list(),
      manifest,
    }, writeBody);
    return;
  }

  if (requestUrl.pathname === '/_pwdev/env') {
    const env = pwDevEnv({
      serverUrl,
      root,
      worktree,
      brokerUrl: broker.summary().url,
      proxyManagerUrl,
    });
    const wantsSh =
      requestUrl.searchParams.get('format') === 'sh' ||
      (req.headers.accept ?? '').includes('text/x-shellscript');
    if (wantsSh) {
      writeTypedText(res, 200, 'text/x-shellscript; charset=utf-8', renderEnvSh(env), writeBody);
    } else {
      writeJson(res, 200, env, writeBody);
    }
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
    networkId: metadata.networkId,
    proxyId: metadata.proxyId,
    proxyForwardId: metadata.proxyForwardId,
    proxyServer: metadata.proxyServer,
    serverUrl: origin,
  });
}

/**
 * Create an app registry. It is in-memory by default; callers can supply a
 * persistence callback for durable app metadata.
 *
 * @param {Record<string, unknown>[]=} initialApps Initial app entries to seed.
 * @param {{ persist?: (apps: PwDevAppManifest[]) => void }=} options
 * @returns {PwDevAppRegistry}
 */
export function createAppRegistry(initialApps = [], options = {}) {
  const apps = new Map();
  const persist = () => options.persist?.(Array.from(apps.values()).map(persistedApp));
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
      const { profile: _profile, devserver: _devserver, servers: _servers, engine: _engine, ...current } = existing ?? {};
      const saved = {
        ...current,
        ...app,
        updatedAt: new Date().toISOString(),
      };
      if (!saved.name) saved.name = saved.id;
      if (!existing?.createdAt) saved.createdAt = saved.updatedAt;
      apps.set(saved.id, saved);
      persist();
      return cloneApp(saved);
    },
    update(id, patch) {
      const existing = apps.get(id);
      if (!existing) return undefined;
      const saved = { ...existing };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === null) {
          delete saved[key];
        } else {
          saved[key] = value;
        }
      }
      saved.updatedAt = new Date().toISOString();
      apps.set(id, saved);
      persist();
      return cloneApp(saved);
    },
    delete(id) {
      const deleted = apps.delete(id);
      if (deleted) persist();
      return deleted;
    },
  };

  for (const rawApp of initialApps) {
    const app = validateAppRegistration(rawApp);
    const saved = { ...app };
    if (!saved.name) saved.name = saved.id;
    apps.set(saved.id, saved);
  }
  return registry;
}

/**
 * Load app metadata from the durable server registry. Runtime browser state is
 * deliberately discarded: broker sessions are owned by the broker and cannot
 * be valid after a server restart.
 *
 * @param {string} appRegistryFile
 * @returns {Record<string, unknown>[]}
 */
function loadPersistedApps(appRegistryFile) {
  if (!existsSync(appRegistryFile)) return [];
  try {
    const parsed = JSON.parse(readFileSync(appRegistryFile, 'utf8'));
    if (!parsed || !Array.isArray(parsed.apps)) {
      throw new Error('expected an object with an apps array');
    }
    return parsed.apps.map(persistedApp);
  } catch (error) {
    throw new Error(`Could not load app registry ${appRegistryFile}: ${error.message}`);
  }
}

/**
 * Atomically persist durable app metadata with owner-only permissions because
 * registrations may contain non-production test credentials.
 *
 * @param {string} appRegistryFile
 * @param {PwDevAppManifest[]} registeredApps
 */
function persistApps(appRegistryFile, registeredApps) {
  persistRegistryFile(appRegistryFile, { version: 1, apps: registeredApps });
}

/**
 * Remove fields that describe a live browser or a specific server process.
 * Also drops retired registration fields so a registry created by an older
 * pw-dev release migrates forward on its next write.
 *
 * @param {Record<string, unknown>} app
 * @returns {Record<string, unknown>}
 */
function persistedApp(app) {
  const {
    browserInstanceId: _browserInstanceId,
    browserStartedAt: _browserStartedAt,
    activeTask: _activeTask,
    browserSessions: _browserSessions,
    cdpUrl: _cdpUrl,
    serverUrl: _serverUrl,
    profile: _profile,
    devserver: _devserver,
    servers: _servers,
    engine: _engine,
    ...persistent
  } = app;
  return persistent;
}

function createNetworkRegistry(initialNetworks = [], options = {}) {
  const networks = new Map(initialNetworks.map((network) => [network.id, persistedNetwork(network)]));
  const persist = () => options.persist?.(Array.from(networks.values()));
  return {
    list() {
      return Array.from(networks.values()).sort((a, b) => a.id.localeCompare(b.id)).map(persistedNetwork);
    },
    upsert(network) {
      const saved = persistedNetwork(network);
      if (typeof saved.id !== 'string' || saved.id.trim() === '') throw new Error('network id must be a non-empty string');
      networks.set(saved.id, saved);
      persist();
      return persistedNetwork(saved);
    },
    delete(id) {
      const deleted = networks.delete(id);
      if (deleted) persist();
      return deleted;
    },
  };
}

function loadPersistedNetworks(networkRegistryFile) {
  if (!existsSync(networkRegistryFile)) return [];
  try {
    const parsed = JSON.parse(readFileSync(networkRegistryFile, 'utf8'));
    if (!parsed || !Array.isArray(parsed.networks)) throw new Error('expected an object with a networks array');
    return parsed.networks.map(persistedNetwork);
  } catch (error) {
    throw new Error(`Could not load network registry ${networkRegistryFile}: ${error.message}`);
  }
}

function persistNetworks(networkRegistryFile, networks) {
  persistRegistryFile(networkRegistryFile, { version: 1, networks });
}

function persistedNetwork(network) {
  const { resolved: _resolved, createdAt: _createdAt, updatedAt: _updatedAt, inUseBy: _inUseBy, ...persistent } = network;
  return persistent;
}

function createBrowserRegistry(initialBrowsers = [], options = {}) {
  const browsers = new Map(initialBrowsers.map((browser) => [browser.id, browser]));
  const persist = () => options.persist?.(Array.from(browsers.values()));
  return {
    list: () => Array.from(browsers.values()).sort((a, b) => a.id.localeCompare(b.id)).map((browser) => ({ ...browser })),
    get: (id) => browsers.has(id) ? { ...browsers.get(id) } : undefined,
    upsert(raw) {
      const browser = validateBrowserTemplate(raw);
      const existing = browsers.get(browser.id);
      const saved = { ...existing, ...browser, updatedAt: new Date().toISOString() };
      if (!existing?.createdAt) saved.createdAt = saved.updatedAt;
      browsers.set(saved.id, saved);
      persist();
      return { ...saved };
    },
    delete(id) {
      const deleted = browsers.delete(id);
      if (deleted) persist();
      return deleted;
    },
  };
}

function loadPersistedBrowsers(file) {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.browsers)) throw new Error('expected an object with a browsers array');
    return parsed.browsers.map(validateBrowserTemplate);
  } catch (error) {
    throw new Error(`Could not load browser registry ${file}: ${error.message}`);
  }
}

/** @param {string} proxyRegistryFile @returns {Record<string, unknown>[]} */
function loadPersistedProxies(proxyRegistryFile) {
  if (!existsSync(proxyRegistryFile)) return [];
  try {
    const parsed = JSON.parse(readFileSync(proxyRegistryFile, 'utf8'));
    if (!parsed || !Array.isArray(parsed.proxies)) throw new Error('expected an object with a proxies array');
    return parsed.proxies.map(persistedProxy);
  } catch (error) {
    throw new Error(`Could not load proxy registry ${proxyRegistryFile}: ${error.message}`);
  }
}

/** @param {string} proxyRegistryFile @param {PwDevProxyRecord[]} registeredProxies */
function persistProxies(proxyRegistryFile, registeredProxies) {
  persistRegistryFile(proxyRegistryFile, { version: 1, proxies: registeredProxies });
}

function persistRegistryFile(file, content) {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryFile = `${file}.${process.pid}.tmp`;
  writeFileSync(temporaryFile, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryFile, file);
  chmodSync(file, 0o600);
}

/** @param {Record<string, unknown>} proxy @returns {Record<string, unknown>} */
function persistedProxy(proxy) {
  const { pid: _pid, ...persistent } = proxy;
  return persistent;
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

function cloneSession(session) {
  return {
    ...session,
    ...(session.activeTask ? { activeTask: { ...session.activeTask } } : {}),
  };
}

/**
 * Create an in-memory session registry.
 *
 * @param {Record<string, unknown>[]=} initialSessions Initial session entries to seed.
 * @returns {PwDevSessionRegistry}
 */
export function createSessionRegistry(initialSessions = []) {
  const sessions = new Map();
  const registry = {
    list() {
      return Array.from(sessions.values())
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
        .map((session) => cloneSession(session));
    },
    get(id) {
      const session = sessions.get(id);
      return session ? cloneSession(session) : undefined;
    },
    upsert(rawSession) {
      const session = validateSessionRegistration(rawSession);
      const existing = sessions.get(session.sessionId);
      const saved = {
        ...existing,
        ...session,
      };
      sessions.set(saved.sessionId, saved);
      return cloneSession(saved);
    },
    update(id, patch) {
      const existing = sessions.get(id);
      if (!existing) return undefined;
      const saved = { ...existing };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === null) {
          delete saved[key];
        } else {
          saved[key] = value;
        }
      }
      sessions.set(id, saved);
      return cloneSession(saved);
    },
    delete(id) {
      return sessions.delete(id);
    },
    listByApp(appId) {
      return Array.from(sessions.values())
        .filter((session) => session.appId === appId)
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
        .map((session) => cloneSession(session));
    },
    listByBrowser(browserId) {
      return Array.from(sessions.values())
        .filter((session) => session.browserId === browserId)
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
        .map((session) => cloneSession(session));
    },
  };

  for (const session of initialSessions) registry.upsert(session);
  return registry;
}

/**
 * Create an in-memory proxy registry.
 *
 * @param {Record<string, unknown>[]=} initialProxies Initial proxy entries to seed.
 * @returns {PwDevProxyRegistry}
 */
export function createProxyRegistry(initialProxies = [], options = {}) {
  const proxies = new Map();
  const persist = () => options.persist?.(Array.from(proxies.values()).map(persistedProxy));
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
      persist();
      return { ...saved };
    },
    delete(id) {
      const deleted = proxies.delete(id);
      if (deleted) persist();
      return deleted;
    },
  };

  for (const rawProxy of initialProxies) {
    const proxy = validateProxyRegistration(rawProxy);
    proxies.set(proxy.id, proxy);
  }
  return registry;
}

/**
 * Managed proxy processes live in the proxy manager, while their configuration
 * is mirrored in this registry. Remove only managed records absent from a
 * reachable manager; manually registered external proxies remain untouched.
 */
async function reconcileManagedProxies({ apps, proxies, proxyManagerUrl }) {
  let status;
  try {
    status = await brokerJson(proxyManagerUrl, '/_proxy/status');
  } catch {
    return;
  }
  const liveManagedProxies = Array.isArray(status.proxies)
    ? status.proxies
        .filter((proxy) => proxy && typeof proxy === 'object' && typeof proxy.id === 'string' && proxy.id.trim() !== '')
        .map((proxy) => ({
          id: proxy.id,
          kind: proxy.kind,
          name: proxy.name,
          appId: proxy.appId,
          taskId: proxy.taskId,
          owner: proxy.owner,
          purpose: proxy.purpose,
          labels: proxy.labels,
          proxyUrl: proxy.proxyUrl,
          guiUrl: proxy.guiUrl,
          storageDir: proxy.storageDir,
          proxyPort: proxy.proxyPort,
          uiPort: proxy.uiPort,
          pid: proxy.pid,
          rulesetFile: proxy.rulesetFile,
          rules: proxy.rules,
          managed: true,
          createdAt: proxy.createdAt ?? proxy.startedAt,
          updatedAt: proxy.updatedAt,
        }))
    : [];
  const liveIds = new Set(liveManagedProxies.map((proxy) => proxy.id));

  for (const proxy of liveManagedProxies) {
    proxies.upsert(proxy);
    if (proxy.appId) {
      const app = apps.get(proxy.appId);
      if (app && app.proxyId !== proxy.id) {
        apps.update(proxy.appId, { proxyId: proxy.id });
      }
    }
  }

  const staleIds = proxies.list()
    .filter((proxy) => proxy.managed && !liveIds.has(proxy.id))
    .map((proxy) => proxy.id);
  if (!staleIds.length) return;

  for (const id of staleIds) proxies.delete(id);
  for (const app of apps.list()) {
    if (app.proxyId && staleIds.includes(app.proxyId)) {
      apps.update(app.id, { proxyId: undefined });
    }
  }
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
 *   apps: PwDevAppRegistry,
 *   proxies: PwDevProxyRegistry,
 *   proxyManagerUrl: string,
 *   writeBody: boolean,
 * }} options
 * @returns {Promise<void>}
 */
async function handleProxiesRequest({ req, res, requestUrl, apps, proxies, proxyManagerUrl, writeBody }) {
  const pathParts = requestUrl.pathname.split('/').filter(Boolean);

  if (pathParts.length === 2 && pathParts[0] === '_pwdev' && pathParts[1] === 'proxies') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      await reconcileManagedProxies({ apps, proxies, proxyManagerUrl });
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

  const trafficId = pathParts[2] ? decodeURIComponent(pathParts[2]) : undefined;
  if (pathParts.length === 4 && pathParts[0] === '_pwdev' && pathParts[1] === 'proxies' && pathParts[3] === 'traffic') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end('Method Not Allowed');
      return;
    }
    const proxy = trafficId && proxies.get(trafficId);
    if (!proxy) {
      writeJson(res, 404, { ok: false, error: `Unknown proxy: ${trafficId}` }, writeBody);
      return;
    }
    if (!proxy.guiUrl) {
      writeJson(res, 409, { ok: false, error: `Proxy ${trafficId} does not expose a Whistle GUI traffic feed` }, writeBody);
      return;
    }
    const traffic = await getWhistleTraffic(proxy.guiUrl, requestUrl.searchParams);
    writeJson(res, 200, { ok: true, proxyId: trafficId, traffic }, writeBody);
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
 * Read Whistle's internal Network feed through a stable pw-dev JSON route.
 * Only Whistle's documented feed parameters are forwarded so this route cannot
 * become a general-purpose GUI proxy.
 *
 * @param {string} guiUrl
 * @param {URLSearchParams} searchParams
 * @returns {Promise<Record<string, unknown>>}
 */
async function getWhistleTraffic(guiUrl, searchParams) {
  const allowed = new Set([
    'count', 'dumpCount', 'startTime', 'lastRowId', 'ids', 'status',
    'url', 'ip', 'mtype', 'name', 'value',
  ]);
  for (let index = 1; index < 6; index += 1) {
    allowed.add(`name${index}`);
    allowed.add(`value${index}`);
  }
  const query = new URLSearchParams();
  for (const [key, value] of searchParams) {
    if (allowed.has(key)) query.append(key, value);
  }
  const upstreamUrl = new URL('/cgi-bin/get-data', ensureTrailingSlash(guiUrl));
  upstreamUrl.search = query.toString();
  const { statusCode, text } = await new Promise((resolve, reject) => {
    const request = http.request(upstreamUrl, {
      method: 'GET',
      headers: { accept: 'application/json', 'accept-encoding': 'identity' },
    }, (response) => {
      let responseText = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseText += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode || 0, text: responseText }));
    });
    request.once('error', (cause) => reject(cause));
    request.end();
  }).catch((cause) => {
    const error = new Error(`Whistle GUI is unreachable at ${guiUrl}: ${cause?.message || 'request failed'}`);
    error.statusCode = 502;
    throw error;
  });
  let traffic;
  try {
    traffic = text ? JSON.parse(text) : {};
  } catch {
    const error = new Error(`Whistle GUI returned invalid traffic JSON at ${guiUrl}`);
    error.statusCode = 502;
    throw error;
  }
  if (statusCode < 200 || statusCode >= 300) {
    const error = new Error(traffic.error || `Whistle traffic request failed: ${statusCode}`);
    error.statusCode = statusCode || 502;
    throw error;
  }
  return traffic;
}

function composeDefaultBrowserSessionId(appId) {
  return `${appId}__default`;
}

function splitAppSessions(sessions, appId) {
  const appSessions = sessions.listByApp(appId);
  const defaultSession = appSessions.find((session) => session.scope === 'default');
  const taskSessions = Object.fromEntries(
    appSessions
      .filter((session) => session.scope === 'task')
      .map((session) => [session.sessionId, session])
  );
  return {
    defaultSession,
    taskSessions,
    allSessions: appSessions,
  };
}

function buildAppResponse(app, sessions) {
  const { defaultSession, taskSessions } = splitAppSessions(sessions, app.id);
  return omitUndefined({
    ...app,
    cdpUrl: defaultSession?.cdpUrl,
    profile: defaultSession?.profile,
    networkId: defaultSession?.networkId ?? app.networkId,
    proxyId: defaultSession?.proxyId ?? app.proxyId,
    proxyForwardId: defaultSession?.proxyForwardId ?? app.proxyForwardId,
    proxyServer: defaultSession?.proxyServer ?? app.proxyServer,
    browserInstanceId: defaultSession?.browserInstanceId,
    browserStartedAt: defaultSession?.browserStartedAt,
    activeTask: defaultSession?.activeTask,
    browserSessions: Object.keys(taskSessions).length ? taskSessions : undefined,
  });
}

async function reconcileSessionsBestEffort({ sessions, broker, appId }) {
  const relevantSessions = appId ? sessions.listByApp(appId) : sessions.list();
  if (!relevantSessions.length) return;

  const brokerUrls = new Map();
  for (const session of relevantSessions) {
    const brokerUrl = broker.resolve(session.brokerUrl);
    if (!brokerUrls.has(brokerUrl)) brokerUrls.set(brokerUrl, []);
    brokerUrls.get(brokerUrl).push(session);
  }

  for (const [brokerUrl, groupedSessions] of brokerUrls) {
    let status;
    try {
      status = await brokerJson(brokerUrl, '/_broker/status');
    } catch {
      continue;
    }
    const liveInstanceIds = new Set(
      Array.isArray(status.instances)
        ? status.instances.map((instance) => instance?.id ?? instance?.instanceId).filter(Boolean)
        : []
    );
    for (const session of groupedSessions) {
      if (!liveInstanceIds.has(session.browserInstanceId)) {
        sessions.delete(session.sessionId);
      }
    }
  }
}

async function reconcileAppBrowserSessionsBestEffort({ apps, sessions, broker, app }) {
  await reconcileSessionsBestEffort({ sessions, broker, appId: app.id });
  return buildAppResponse(apps.get(app.id) ?? app, sessions);
}

/**
 * Handle first-class session routes under `/_pwdev/sessions`.
 *
 * @param {{
 *   req: http.IncomingMessage,
 *   res: http.ServerResponse,
 *   requestUrl: URL,
 *   apps: PwDevAppRegistry,
 *   sessions: PwDevSessionRegistry,
 *   broker: PwDevBrokerPairing,
 *   serverUrl: string,
 *   writeBody: boolean,
 * }} options
 * @returns {Promise<void>}
 */
async function handleSessionsRequest({ req, res, requestUrl, apps, sessions, broker, serverUrl, writeBody }) {
  const pathParts = requestUrl.pathname.split('/').filter(Boolean);

  if (pathParts.length === 2 && pathParts[0] === '_pwdev' && pathParts[1] === 'sessions') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end('Method Not Allowed');
      return;
    }
    await reconcileSessionsBestEffort({ sessions, broker });
    writeJson(res, 200, { ok: true, sessions: sessions.list() }, writeBody);
    return;
  }

  const sessionId = pathParts[2] ? decodeURIComponent(pathParts[2]) : undefined;
  if (!sessionId || pathParts[0] !== '_pwdev' || pathParts[1] !== 'sessions') {
    writeJson(res, 404, { ok: false, error: 'Unknown pw-dev sessions endpoint' }, writeBody);
    return;
  }

  if (pathParts.length === 3) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end('Method Not Allowed');
      return;
    }
    await reconcileSessionsBestEffort({ sessions, broker });
    const session = sessions.get(sessionId);
    if (!session) {
      writeJson(res, 404, { ok: false, error: `Unknown session: ${sessionId}` }, writeBody);
      return;
    }
    const app = apps.get(session.appId);
    writeJson(res, 200, { ok: true, session, app: app ? buildAppResponse(app, sessions) : undefined, serverUrl }, writeBody);
    return;
  }

  if (pathParts.length === 4 && pathParts[3] === 'stop') {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      res.end('Method Not Allowed');
      return;
    }
    await reconcileSessionsBestEffort({ sessions, broker });
    const session = sessions.get(sessionId);
    if (!session) {
      writeJson(res, 404, { ok: false, error: `Unknown session: ${sessionId}` }, writeBody);
      return;
    }
    const stop = await brokerJson(session.brokerUrl, '/_broker/stop', {
      method: 'POST',
      body: { instanceId: session.browserInstanceId },
    });
    sessions.delete(sessionId);
    const app = apps.get(session.appId);
    writeJson(res, 200, {
      ok: true,
      session,
      app: app ? buildAppResponse(app, sessions) : undefined,
      browser: stop,
    }, writeBody);
    return;
  }

  writeJson(res, 404, { ok: false, error: 'Unknown pw-dev sessions endpoint' }, writeBody);
}

/**
 * Handle central app registry routes under `/_pwdev/apps`.
 *
 * `POST /_pwdev/apps` is an upsert. Re-posting the same app id updates its
 * app URL, worktree, branch, agent instructions, and network/proxy metadata in place.
 *
 * @param {{
 *   req: http.IncomingMessage,
 *   res: http.ServerResponse,
 *   requestUrl: URL,
 *   apps: PwDevAppRegistry,
 *   proxies: PwDevProxyRegistry,
 *   sessions: PwDevSessionRegistry,
 *   broker: PwDevBrokerPairing,
 *   serverUrl: string,
 *   writeBody: boolean,
 * }} options
 * @returns {Promise<void>}
 */
async function handleBrowserTemplatesRequest({ req, res, requestUrl, apps, browsers, proxies, sessions, broker, serverUrl, writeBody }) {
  const parts = requestUrl.pathname.split('/').filter(Boolean);
  await reconcileSessionsBestEffort({ sessions, broker });
  const withRuntime = (template) => ({ ...template, runtime: sessions.listByBrowser(template.id).find((session) => session.scope === 'default'), sessions: sessions.listByBrowser(template.id) });
  if (parts.length === 2) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      writeJson(res, 200, { ok: true, browsers: browsers.list().map(withRuntime) }, writeBody);
      return;
    }
    if (req.method === 'POST') {
      const browser = browsers.upsert(await readJsonBody(req));
      writeJson(res, 200, { ok: true, browser });
      return;
    }
  }
  const id = parts[2] ? decodeURIComponent(parts[2]) : undefined;
  const template = id ? browsers.get(id) : undefined;
  if (!id || !template) {
    writeJson(res, 404, { ok: false, error: `Unknown browser template: ${id}` }, writeBody);
    return;
  }
  if (parts.length === 3 && (req.method === 'GET' || req.method === 'HEAD')) {
    writeJson(res, 200, { ok: true, browser: withRuntime(template) }, writeBody);
    return;
  }
  if (parts.length === 3 && req.method === 'DELETE') {
    browsers.delete(id);
    writeJson(res, 200, { ok: true, id }, writeBody);
    return;
  }
  const action = parts[3];
  if (parts.length === 4 && action === 'start' && req.method === 'POST') {
    const payload = await readJsonBody(req);
    const app = template.appId ? apps.get(template.appId) : undefined;
    if (template.appId && !app) throwValidationError(`Unknown app for browser template: ${template.appId}`);
    const requestedSessionId = payload.sessionId === undefined ? undefined : requiredString(payload.sessionId, 'sessionId');
    if (requestedSessionId) validateBrowserProfileName(requestedSessionId, 'sessionId');
    const scope = requestedSessionId ? 'task' : 'default';
    const sessionId = requestedSessionId ? `${id}__${requestedSessionId}` : `${id}__default`;
    const profile = payload.profile === undefined
      ? requestedSessionId ? `${template.profile ?? template.id}__${requestedSessionId}` : template.profile ?? template.id
      : requiredString(payload.profile, 'profile');
    validateBrowserProfileName(profile, 'profile');
    const existing = sessions.get(sessionId);
    if (existing) {
      writeJson(res, 409, { ok: false, error: 'Browser template session is already active', session: existing }, writeBody);
      return;
    }
    const brokerUrl = broker.resolve(template.brokerUrl ?? app?.brokerUrl);
    const network = {};
    const proxy = resolveProxyForBrowserStart({ proxies, proxyId: template.proxyId ?? app?.proxyId });
    const brokerStatus = proxy.proxyId && proxy.proxyServer ? await brokerJson(brokerUrl, '/_broker/status') : undefined;
    const proxyPeer = brokerStatus?.topology?.mode === 'ssh' && brokerStatus.topology.remote ? 'ssh-peer' : undefined;
    const start = await brokerJson(brokerUrl, '/_broker/start', {
      method: 'POST',
      body: omitUndefined({
        profile,
        proxyServer: proxy.proxyServer,
        proxyForwardId: proxy.proxyForwardId,
        proxyPeer,
        proxyName: proxyPeer ? proxy.proxyId : undefined,
        ignoreSslErrors: payload.ignoreSslErrors ?? template.ignoreSslErrors,
        proxyBypassList: payload.proxyBypassList ?? template.proxyBypassList,
        headless: payload.headless ?? template.headless,
        resetProfile: payload.resetProfile ?? template.resetProfile,
      }),
    });
    const cdpUrl = rewriteBrokerUrlToServerProxy(start.cdpUrl, serverUrl);
    const session = sessions.upsert(makeBrowserSession({
      sessionId, appId: template.appId, browserId: id, scope,
      brokerUrl, start, profile, cdpUrl, network, proxy,
    }));
    writeJson(res, 200, { ok: true, browser: { ...template, runtime: session }, session, start: { ...start, cdpUrl } }, writeBody);
    return;
  }
  if (parts.length === 4 && action === 'stop' && req.method === 'POST') {
    const payload = await readJsonBody(req);
    const requestedSessionId = payload.sessionId === undefined ? undefined : requiredString(payload.sessionId, 'sessionId');
    const runtime = requestedSessionId
      ? sessions.get(`${id}__${requestedSessionId}`)
      : sessions.listByBrowser(id).find((session) => session.scope === 'default');
    if (!runtime?.browserInstanceId) {
      writeJson(res, 200, { ok: true, browser: { ...template }, alreadyStopped: true }, writeBody);
      return;
    }
    const stop = await brokerJson(runtime.brokerUrl, '/_broker/stop', { method: 'POST', body: { instanceId: runtime.browserInstanceId } });
    sessions.delete(runtime.sessionId);
    writeJson(res, 200, { ok: true, browser: template, stop }, writeBody);
    return;
  }
  writeJson(res, 404, { ok: false, error: 'Unknown browser template endpoint' }, writeBody);
}

async function handleAppsRequest({ req, res, requestUrl, apps, proxies, sessions, broker, serverUrl, writeBody }) {
  const pathParts = requestUrl.pathname.split('/').filter(Boolean);

  if (pathParts.length === 2 && pathParts[0] === '_pwdev' && pathParts[1] === 'apps') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const listedApps = await Promise.all(apps.list().map((app) => reconcileAppBrowserSessionsBestEffort({
        apps,
        sessions,
        broker,
        app,
      })));
      writeJson(res, 200, { ok: true, apps: listedApps }, writeBody);
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
      const currentApp = await reconcileAppBrowserSessionsBestEffort({ apps, sessions, broker, app });
      writeJson(res, 200, { ok: true, app: currentApp }, writeBody);
      return;
    }

    if (req.method === 'PATCH') {
      const app = apps.update(id, validateAppPatch(await readJsonBody(req)));
      writeJson(res, app ? 200 : 404, app
        ? { ok: true, app }
        : { ok: false, error: `Unknown app: ${id}` });
      return;
    }

    if (req.method === 'DELETE') {
      const deleted = apps.delete(id);
      writeJson(res, deleted ? 200 : 404, deleted
        ? { ok: true, id }
        : { ok: false, error: `Unknown app: ${id}` });
      return;
    }

    res.writeHead(405, { allow: 'GET, HEAD, PATCH, DELETE' });
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
    const currentApp = await reconcileAppBrowserSessionsBestEffort({ apps, sessions, broker, app });
    writeJson(res, 200, currentApp, writeBody);
    return;
  }

  if (pathParts.length === 5 && pathParts[3] === 'browser') {
    writeJson(res, 410, {
      ok: false,
      error: 'App-scoped browser lifecycle is retired. Create and start a persisted browser template under /_pwdev/browsers.',
    }, writeBody);
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
async function proxyBrokerHttpRequest({ req, res, requestUrl, broker, brokerPath }) {
  const brokerUrl = broker.resolve();
  const upstreamUrl = new URL(brokerPath ?? proxyBrokerPath(requestUrl), ensureTrailingSlash(brokerUrl));
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
 * Proxy proxy HTTP APIs through the pw-dev server.
 *
 * `/_pwdev/proxy/*` maps to the manager's `/_proxy/*` namespace.
 *
 * @param {{
 *   req: http.IncomingMessage,
 *   res: http.ServerResponse,
 *   requestUrl: URL,
 *   proxyManagerUrl: string,
 * }} options
 * @returns {Promise<void>}
 */
async function proxyProxyManagerHttpRequest({ req, res, requestUrl, proxyManagerUrl }) {
  const upstreamUrl = new URL(proxyProxyManagerPath(requestUrl), ensureTrailingSlash(proxyManagerUrl));
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
      error: `proxy is unreachable at ${proxyManagerUrl}: ${error.message}`,
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

function proxyBrokerNetworksPath(requestUrl) {
  const suffix = requestUrl.pathname.slice('/_pwdev/networks'.length);
  return `/_broker/networks${suffix || ''}${requestUrl.search}`;
}

function proxyProxyManagerPath(requestUrl) {
  const suffix = requestUrl.pathname.slice('/_pwdev/proxy'.length);
  return `/_proxy${suffix || ''}${requestUrl.search}`;
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
 *   sessions: PwDevSessionRegistry,
 *   broker: PwDevBrokerPairing,
 *   serverUrl: string,
 *   id: string,
 *   command: string,
 *   writeBody: boolean,
 * }} options
 * @returns {Promise<void>}
 */
async function handleAppBrowserRequest({ req, res, apps, proxies, sessions, broker, serverUrl, id, command, writeBody }) {
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
    await reconcileSessionsBestEffort({ sessions, broker, appId: id });
    const currentApp = buildAppResponse(app, sessions);
    writeJson(res, 200, { ok: true, app: currentApp, broker: status }, writeBody);
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
    await reconcileSessionsBestEffort({ sessions, broker, appId: id });
    const currentApp = buildAppResponse(app, sessions);
    const conflict = findBrowserSessionConflict({ app: currentApp, sessions, slot });
    if (conflict) {
      writeJson(res, 409, conflict);
      return;
    }
    const network = {};
    const proxy = resolveProxyForBrowserStart({
      proxies,
      proxyId: payload.proxyId ?? app.proxyId,
      proxyForwardId: payload.proxyForwardId ?? app.proxyForwardId,
      proxyServer: payload.proxyServer ?? app.proxyServer,
    });
    const brokerStatus = proxy.proxyId && proxy.proxyServer
      ? await brokerJson(brokerUrl, '/_broker/status')
      : undefined;
    const proxyPeer = brokerStatus?.topology?.mode === 'ssh' && brokerStatus.topology.remote
      ? 'ssh-peer'
      : undefined;
    const start = await brokerJson(brokerUrl, '/_broker/start', {
      method: 'POST',
      body: omitUndefined({
        profile: slot.profile,
        proxyForwardId: proxy.proxyForwardId,
        proxyServer: proxy.proxyServer,
        proxyPeer,
        proxyName: proxyPeer ? proxy.proxyId : undefined,
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
    let session;
    session = sessions.upsert(makeBrowserSession({
      sessionId: slot.sessionId,
      appId: id,
      scope: slot.taskId ? 'task' : 'default',
      task,
      activeTask,
      brokerUrl,
      start,
      profile: slot.profile,
      cdpUrl: proxiedCdpUrl,
      network,
      proxy,
    }));
    const updated = buildAppResponse(apps.get(id) ?? app, sessions);
    writeJson(res, 200, omitUndefined({ ok: true, app: updated, session: slot.taskId ? session : undefined, browser }));
    return;
  }

  if (command === 'stop') {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      res.end('Method Not Allowed');
      return;
    }
    const payload = await readJsonBody(req);
    await reconcileSessionsBestEffort({ sessions, broker, appId: id });
    const stopTarget = resolveBrowserStopTarget({ app, sessions, payload });
    const instanceId = stopTarget?.browserInstanceId;
    if (!instanceId) {
      writeJson(res, 400, { ok: false, error: `App has no browser instance: ${id}` });
      return;
    }
    const stop = await brokerJson(stopTarget.session?.brokerUrl ?? broker.resolve(payload.brokerUrl ?? app.brokerUrl), '/_broker/stop', {
      method: 'POST',
      body: { instanceId },
    });
    if (stopTarget.sessionId) sessions.delete(stopTarget.sessionId);
    else if (stopTarget.session?.sessionId) sessions.delete(stopTarget.session.sessionId);
    const updated = buildAppResponse(apps.get(id) ?? app, sessions);
    writeJson(res, 200, { ok: true, app: updated, session: stopTarget.session, browser: stop });
    return;
  }

  writeJson(res, 404, { ok: false, error: 'Unknown app browser endpoint' }, writeBody);
}

function resolveBrowserSessionSlot({ app, payload, task }) {
  const sessionId = task ? composeBrowserSessionId(app.id, task.id) : composeDefaultBrowserSessionId(app.id);
  const profile = payload.profile !== undefined
    ? requiredString(payload.profile, 'profile')
    : task
      ? composeBrowserSessionId(app.id, task.id)
      : app.id;
  validateBrowserProfileName(profile, 'profile');
  return {
    taskId: task?.id,
    sessionId,
    profile,
  };
}

function findBrowserSessionConflict({ app, sessions, slot }) {
  const { defaultSession, taskSessions, allSessions } = splitAppSessions(sessions, app.id);
  if (slot.taskId) {
    const existing = taskSessions[slot.sessionId];
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
  } else if (defaultSession) {
    return {
      ok: false,
      error: 'App already has an active browser task',
      appId: app.id,
      browserInstanceId: defaultSession.browserInstanceId,
      activeTask: defaultSession.activeTask,
    };
  }

  const profileConflict = findActiveBrowserProfile(allSessions, slot.profile);
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

function findActiveBrowserProfile(sessions, profile) {
  for (const session of sessions) {
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

function makeBrowserSession({ sessionId, appId, browserId, scope, task, activeTask, brokerUrl, start, profile, cdpUrl, network, proxy }) {
  return omitUndefined({
    sessionId,
    appId,
    browserId,
    scope,
    taskId: task?.id,
    profile: start.profile ?? profile,
    cdpUrl,
    brokerUrl,
    browserInstanceId: start.instanceId,
    browserStartedAt: start.startedAt,
    networkId: start.networkId ?? network.networkId,
    proxyId: proxy.proxyId,
    proxyForwardId: start.proxyForwardId,
    proxyServer: start.proxyServer,
    activeTask,
  });
}

function resolveBrowserStopTarget({ app, sessions, payload }) {
  const { defaultSession, taskSessions, allSessions } = splitAppSessions(sessions, app.id);
  const sessionId = optionalString(payload.sessionId, 'sessionId');
  if (sessionId) {
    const session = taskSessions[sessionId] ?? (defaultSession?.sessionId === sessionId ? defaultSession : undefined);
    return session ? { sessionId, taskId: session.taskId, session, browserInstanceId: session.browserInstanceId } : undefined;
  }

  const taskId = payload.taskId !== undefined
    ? requiredString(payload.taskId, 'taskId')
    : payload.task === undefined
      ? undefined
      : validateTaskInput(payload.task).id;
  if (taskId) {
    const session = allSessions.find((candidate) => candidate.taskId === taskId);
    return session ? { sessionId: session.sessionId, taskId, session, browserInstanceId: session.browserInstanceId } : undefined;
  }

  const instanceId = optionalString(payload.instanceId, 'instanceId');
  if (instanceId) {
    for (const session of allSessions) {
      if (session.browserInstanceId === instanceId) {
        return { sessionId: session.sessionId, taskId: session.taskId, session, browserInstanceId: session.browserInstanceId };
      }
    }
    return undefined;
  }

  return defaultSession ? {
    sessionId: defaultSession.sessionId,
    session: defaultSession,
    browserInstanceId: defaultSession.browserInstanceId,
  } : undefined;
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
 * Registration is deliberately metadata-only. Browser ownership is handled
 * later through app-scoped browser endpoints that call the broker.
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
  for (const field of ['profile', 'devserver', 'servers', 'engine']) {
    if (Object.hasOwn(rawApp, field)) {
      throwValidationError(`${field} is not supported in app registration`);
    }
  }

  const app = {
    ok: true,
    id,
    name: optionalString(rawApp.name, 'name'),
    root: optionalPath(rawApp.root, 'root'),
    worktree: optionalPath(rawApp.worktree, 'worktree'),
    branch: optionalString(rawApp.branch, 'branch'),
    appUrl: optionalString(rawApp.appUrl, 'appUrl'),
    readme: optionalString(rawApp.readme, 'readme'),
    accounts: rawApp.accounts === undefined ? undefined : validateAccounts(rawApp.accounts),
    brokerUrl: optionalString(rawApp.brokerUrl, 'brokerUrl'),
    cdpUrl: optionalString(rawApp.cdpUrl, 'cdpUrl'),
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

function validateBrowserTemplate(rawBrowser) {
  if (!rawBrowser || typeof rawBrowser !== 'object' || Array.isArray(rawBrowser)) {
    throwValidationError('browser template must be an object');
  }
  const id = requiredString(rawBrowser.id, 'id');
  const appId = optionalString(rawBrowser.appId, 'appId');
  const profile = optionalString(rawBrowser.profile, 'profile');
  if (profile) validateBrowserProfileName(profile, 'profile');
  return omitUndefined({
    id,
    appId,
    name: optionalString(rawBrowser.name, 'name'),
    targetUrl: optionalString(rawBrowser.targetUrl, 'targetUrl'),
    profile,
    brokerUrl: optionalString(rawBrowser.brokerUrl, 'brokerUrl'),
    proxyId: optionalString(rawBrowser.proxyId, 'proxyId'),
    proxyBypassList: optionalString(rawBrowser.proxyBypassList, 'proxyBypassList'),
    ignoreSslErrors: rawBrowser.ignoreSslErrors === undefined ? undefined : Boolean(rawBrowser.ignoreSslErrors),
    headless: rawBrowser.headless === undefined ? undefined : Boolean(rawBrowser.headless),
    resetProfile: rawBrowser.resetProfile === undefined ? undefined : Boolean(rawBrowser.resetProfile),
  });
}

function validateAppPatch(rawPatch) {
  if (!rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
    throwValidationError('app patch must be an object');
  }
  const allowed = new Set(['proxyId']);
  for (const key of Object.keys(rawPatch)) {
    if (!allowed.has(key)) throwValidationError(`Unsupported app patch field: ${key}`);
  }
  const patch = {};
  if (Object.hasOwn(rawPatch, 'proxyId')) {
    patch.proxyId = rawPatch.proxyId === null ? null : optionalString(rawPatch.proxyId, 'proxyId');
  }
  return patch;
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
    appId: optionalString(rawProxy.appId, 'appId'),
    taskId: optionalString(rawProxy.taskId, 'taskId'),
    owner: optionalString(rawProxy.owner, 'owner'),
    purpose: optionalString(rawProxy.purpose, 'purpose'),
    labels: rawProxy.labels === undefined ? undefined : validateStringArray(rawProxy.labels, 'labels'),
    proxyUrl: optionalString(rawProxy.proxyUrl, 'proxyUrl'),
    guiUrl: optionalString(rawProxy.guiUrl, 'guiUrl'),
    storageDir: optionalPath(rawProxy.storageDir, 'storageDir'),
    rulesetFile: optionalPath(rawProxy.rulesetFile, 'rulesetFile'),
    proxyPort: rawProxy.proxyPort === undefined ? undefined : requiredPositiveInteger(rawProxy.proxyPort, 'proxyPort'),
    uiPort: rawProxy.uiPort === undefined ? undefined : requiredPositiveInteger(rawProxy.uiPort, 'uiPort'),
    pid: rawProxy.pid === undefined ? undefined : requiredPositiveInteger(rawProxy.pid, 'pid'),
    brokerProxyForwardId: optionalString(rawProxy.brokerProxyForwardId, 'brokerProxyForwardId'),
    rules: rawProxy.rules === undefined ? undefined : validateManagedProxyRules(rawProxy.rules),
    managed: rawProxy.managed === undefined ? undefined : Boolean(rawProxy.managed),
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
  if (proxy.guiUrl) validateHttpUrl(proxy.guiUrl, 'guiUrl');

  return omitUndefined(proxy);
}

function validateManagedProxyRules(rawRules) {
  if (!rawRules || typeof rawRules !== 'object' || Array.isArray(rawRules)) {
    throwValidationError('rules must be an object');
  }
  const rules = {
    defaultRuleset: requiredStringAllowEmpty(rawRules.defaultRuleset, 'rules.defaultRuleset'),
    overrideRuleset: requiredStringAllowEmpty(rawRules.overrideRuleset, 'rules.overrideRuleset'),
    effectiveRuleset: requiredStringAllowEmpty(rawRules.effectiveRuleset, 'rules.effectiveRuleset'),
    version: requiredPositiveInteger(rawRules.version, 'rules.version'),
    updatedAt: requiredString(rawRules.updatedAt, 'rules.updatedAt'),
  };
  return rules;
}

function resolveNetworkForBrowserStart({ networkId, payload }) {
  const normalizedNetworkId = optionalString(networkId, 'networkId');
  if (!normalizedNetworkId) return {};
  if (payload.proxyId || payload.proxyForwardId || payload.proxyServer) {
    throwValidationError('networkId is mutually exclusive with proxyId, proxyForwardId, and proxyServer');
  }
  return { networkId: normalizedNetworkId };
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
    networkId: optionalString(rawSession.networkId, `${name}.networkId`),
    proxyId: optionalString(rawSession.proxyId, `${name}.proxyId`),
    proxyForwardId: optionalString(rawSession.proxyForwardId, `${name}.proxyForwardId`),
    proxyServer: optionalString(rawSession.proxyServer, `${name}.proxyServer`),
    activeTask: validateActiveTask(rawSession.activeTask),
  });
}

function validateSessionRegistration(rawSession) {
  if (!rawSession || typeof rawSession !== 'object' || Array.isArray(rawSession)) {
    throwValidationError('session must be an object');
  }
  const scope = requiredOneOf(rawSession.scope, 'scope', ['default', 'task']);
  return omitUndefined({
    sessionId: requiredString(rawSession.sessionId, 'sessionId'),
    appId: optionalString(rawSession.appId, 'appId'),
    browserId: optionalString(rawSession.browserId, 'browserId'),
    scope,
    taskId: rawSession.taskId === undefined ? undefined : requiredString(rawSession.taskId, 'taskId'),
    profile: requiredString(rawSession.profile, 'profile'),
    cdpUrl: requiredString(rawSession.cdpUrl, 'cdpUrl'),
    brokerUrl: requiredString(rawSession.brokerUrl, 'brokerUrl'),
    browserInstanceId: requiredString(rawSession.browserInstanceId, 'browserInstanceId'),
    browserStartedAt: optionalString(rawSession.browserStartedAt, 'browserStartedAt'),
    networkId: optionalString(rawSession.networkId, 'networkId'),
    proxyId: optionalString(rawSession.proxyId, 'proxyId'),
    proxyForwardId: optionalString(rawSession.proxyForwardId, 'proxyForwardId'),
    proxyServer: optionalString(rawSession.proxyServer, 'proxyServer'),
    activeTask: rawSession.activeTask === undefined ? undefined : validateActiveTask(rawSession.activeTask),
  });
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throwValidationError(`${name} must be a non-empty string`);
  }
  return value;
}

function requiredOneOf(value, name, allowed) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throwValidationError(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function requiredStringAllowEmpty(value, name) {
  if (typeof value !== 'string') {
    throwValidationError(`${name} must be a string`);
  }
  return value;
}

function requiredPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throwValidationError(`${name} must be a positive integer`);
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

/**
 * Best-effort resolution of the Playwright-managed Chromium executable.
 *
 * Honors `PLAYWRIGHT_BROWSERS_PATH`, otherwise uses the per-platform default
 * cache dir. Picks the highest-numbered `chromium-<n>` build and the
 * platform-correct executable within it. Returns `undefined` when nothing is
 * installed so callers can omit the key rather than emit a bogus path.
 *
 * @returns {string | undefined}
 */
function resolveChromiumExecutable() {
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH;
  let cacheDir;
  if (override && override !== '0') {
    cacheDir = override;
  } else if (process.platform === 'darwin') {
    cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  } else if (process.platform === 'win32') {
    cacheDir = path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'ms-playwright');
  } else {
    cacheDir = path.join(os.homedir(), '.cache', 'ms-playwright');
  }

  let builds;
  try {
    builds = readdirSync(cacheDir)
      .map((name) => /^chromium-(\d+)$/.exec(name))
      .filter(Boolean)
      .map((match) => ({ name: match[0], version: Number(match[1]) }))
      .sort((a, b) => b.version - a.version);
  } catch {
    return undefined;
  }

  // Newer builds ship the Chrome-for-Testing layout (chrome-linux64/…); older
  // ones use the classic Playwright layout (chrome-linux/…). Try both, newest
  // first, so we never fall back to an older build just because of the folder.
  const relatives =
    process.platform === 'darwin'
      ? [
          path.join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
          path.join('chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
          path.join('chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        ]
      : process.platform === 'win32'
        ? [path.join('chrome-win64', 'chrome.exe'), path.join('chrome-win', 'chrome.exe')]
        : [path.join('chrome-linux64', 'chrome'), path.join('chrome-linux', 'chrome')];

  for (const build of builds) {
    for (const relative of relatives) {
      const candidate = path.join(cacheDir, build.name, relative);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Resolve a file from an installed package without assuming the workspace
 * checkout or node_modules location.
 *
 * @param {string} packageName
 * @param {string} relativePath
 * @returns {string | undefined}
 */
function resolvePackageFile(packageName, relativePath) {
  try {
    const packageJson = require.resolve(`${packageName}/package.json`);
    const candidate = path.join(path.dirname(packageJson), relativePath);
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a package binary from the node_modules/.bin directory containing it.
 *
 * @param {string} packageName
 * @param {string} binaryName
 * @returns {string | undefined}
 */
function resolvePackageBinary(packageName, binaryName) {
  try {
    const packageJson = require.resolve(`${packageName}/package.json`);
    const binName = process.platform === 'win32' ? `${binaryName}.cmd` : binaryName;
    const candidate = path.resolve(path.dirname(packageJson), '..', '..', '.bin', binName);
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the pw-dev environment constants an external (non-Node) script needs to
 * reference the running server, its broker, and the bundled Playwright assets.
 *
 * Computed per request so values track the live server; keys with no resolvable
 * value are omitted rather than emitted empty.
 *
 * @param {{ serverUrl: string, root: string, worktree: string, brokerUrl?: string, proxyManagerUrl: string }} context
 * @returns {Record<string, string>}
 */
function pwDevEnv({ serverUrl, root, worktree, brokerUrl, proxyManagerUrl }) {
  const skillDir = path.join(process.cwd(), '.claude', 'skills', 'playwright-cli');
  const skillPath = path.join(skillDir, 'SKILL.md');
  const chromium = resolveChromiumExecutable();
  const playwrightModule = resolvePackageFile('playwright', 'index.mjs');
  const playwrightCli = resolvePackageBinary('@playwright/cli', 'playwright-cli');
  /** @type {Record<string, string | undefined>} */
  const env = {
    PW_DEV_URL: serverUrl,
    PW_DEV_ROOT: root,
    PW_DEV_WORKTREE: worktree,
    // Prefer the server-proxied broker path; agents should not hit the broker port directly.
    PW_DEV_BROKER_PROXY: `${serverUrl}/_pwdev/broker`,
    PW_DEV_BROKER_URL: brokerUrl,
    PW_DEV_PROXY_MANAGER_URL: proxyManagerUrl,
    PW_DEV_PLAYWRIGHT: playwrightModule,
    PW_DEV_PLAYWRIGHT_CLI: playwrightCli,
    PW_SKILL_PATH: existsSync(skillPath) ? skillPath : undefined,
    PW_SKILL_DIR: existsSync(skillDir) ? skillDir : undefined,
    PW_CHROMIUM_PATH: chromium,
  };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value != null));
}

/**
 * Render pw-dev env constants as sourceable `export KEY='value'` lines for
 * `eval "$(curl -s $PW_DEV_URL/_pwdev/env?format=sh)"`. Single-quote-escaped so
 * arbitrary path/URL characters survive the shell.
 *
 * @param {Record<string, string>} env
 * @returns {string}
 */
function renderEnvSh(env) {
  return (
    Object.entries(env)
      .map(([key, value]) => `export ${key}='${String(value).replace(/'/g, `'\\''`)}'`)
      .join('\n') + '\n'
  );
}

const SERVER_OPENAPI_DOCUMENTS = new Map([
  ['/_pwdev/openapi.json', 'root.json'],
  ['/_pwdev/openapi/apps.json', 'apps.json'],
  ['/_pwdev/openapi/browsers.json', 'browsers.json'],
  ['/_pwdev/openapi/sessions.json', 'sessions.json'],
  ['/_pwdev/openapi/proxies.json', 'proxies/index.json'],
  ['/_pwdev/openapi/proxies/records.json', 'proxies/records.json'],
  ['/_pwdev/openapi/proxies/traffic.json', 'proxies/traffic.json'],
]);

const PROXY_OPENAPI_DOCUMENTS = new Map([
  ['/_pwdev/delegates/proxy/openapi.json', 'root.json'],
  ['/_pwdev/delegates/proxy/openapi/lifecycle.json', 'lifecycle.json'],
  ['/_pwdev/delegates/proxy/openapi/rulesets.json', 'rulesets.json'],
]);

const BROKER_OPENAPI_DOCUMENT = 'root.json';

/** Serve a small, independently-valid OpenAPI document for one control-plane domain. */
function handleOpenApiRequest({ req, res, requestUrl, writeBody }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }
  const relativePath = SERVER_OPENAPI_DOCUMENTS.get(requestUrl.pathname);
  if (!relativePath) {
    writeJson(res, 404, { ok: false, error: 'Unknown pw-dev OpenAPI document' }, writeBody);
    return;
  }
  writeJson(res, 200, readOpenApiDocument(SERVER_PACKAGE_ROOT, relativePath), writeBody);
}

/** Serve the proxy-manager-owned OpenAPI documents through the agent-safe server origin. */
function handleProxyDelegateOpenApiRequest({ req, res, requestUrl, writeBody }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }
  const relativePath = PROXY_OPENAPI_DOCUMENTS.get(requestUrl.pathname);
  if (!relativePath) {
    writeJson(res, 404, { ok: false, error: 'Unknown proxy delegate OpenAPI document' }, writeBody);
    return;
  }
  const document = readOpenApiDocument(PROXY_PACKAGE_ROOT, relativePath);
  // The proxy manager owns this contract, but agents must use the server proxy.
  document.servers = [{ url: '/_pwdev/proxy', description: 'pw-dev server-proxied proxy manager' }];
  if (Array.isArray(document['x-pwdev-documents'])) {
    document['x-pwdev-documents'] = document['x-pwdev-documents'].map((entry) => ({
      ...entry,
      url: typeof entry.url === 'string'
        ? entry.url.replace('/_proxy/openapi/', '/_pwdev/delegates/proxy/openapi/')
        : entry.url,
    }));
  }
  writeJson(res, 200, document, writeBody);
}

function handleBrokerDelegateOpenApiRequest({ req, res, writeBody }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }
  const document = readOpenApiDocument(BROKER_PACKAGE_ROOT, BROKER_OPENAPI_DOCUMENT);
  document.servers = [{ url: '/_pwdev/broker', description: 'pw-dev server-proxied CDP broker' }];
  writeJson(res, 200, document, writeBody);
}

function readOpenApiDocument(packageRoot, relativePath) {
  return JSON.parse(readFileSync(path.join(packageRoot, 'openapi', relativePath), 'utf8'));
}

function pwDevDelegates(serverUrl, proxyManagerUrl, brokerSummary) {
  return {
    ok: true,
    serverUrl,
    delegates: [{
      id: 'broker',
      available: Boolean(brokerSummary?.configured),
      componentUrl: brokerSummary?.url,
      agentBaseUrl: `${serverUrl}/_pwdev/broker`,
      openapiUrl: `${serverUrl}/_pwdev/delegates/broker/openapi.json`,
      instructionsUrl: `${serverUrl}/_pwdev/delegates/broker/instructions`,
      capabilities: ['instances', 'profiles', 'networks', 'proxy-forwards', 'cdp'],
      whenToUse: 'Use advanced broker capabilities not covered by the server browser/session control plane. Prefer server browser and session operations for normal lifecycle work.',
    }, {
      id: 'proxy',
      available: true,
      componentUrl: proxyManagerUrl,
      agentBaseUrl: `${serverUrl}/_pwdev/proxy`,
      openapiUrl: `${serverUrl}/_pwdev/delegates/proxy/openapi.json`,
      instructionsUrl: `${serverUrl}/_pwdev/delegates/proxy/instructions`,
      capabilities: ['lifecycle', 'rulesets'],
      whenToUse: 'Create or manage a Whistle proxy, or replace its rules. Prefer the control-plane proxy records and traffic APIs for registered proxy metadata and captured traffic.',
    }],
  };
}

function brokerDelegateInstructions(serverUrl) {
  return `# pw-dev broker delegate\n\nThis API is owned by the CDP broker and delivered through pw-dev. Use only\n\`${serverUrl}/_pwdev/broker/*\`; do not call the broker port directly.\n\nFetch \`${serverUrl}/_pwdev/delegates/broker/openapi.json\` for advanced instance,\nprofile, network, and proxy-forward operations. Prefer the server control-plane\nbrowser and session APIs for ordinary browser lifecycle work.\n`;
}

function proxyDelegateInstructions(serverUrl) {
  return `# pw-dev proxy delegate\n\nThis API is owned by the proxy manager but is delivered through pw-dev. Use only\n\`${serverUrl}/_pwdev/proxy/*\`; do not call the proxy-manager port directly.\n\nFetch \`${serverUrl}/_pwdev/delegates/proxy/openapi.json\` first. Then load only the\nlinked lifecycle or ruleset document needed for the next operation. Use the\ncontrol-plane \`/_pwdev/openapi/proxies.json\` document to register proxy metadata\nor read captured traffic for a registered proxy.\n`;
}

function pwDevApi(serverUrl) {
  return {
    ok: true,
    version: 1,
    serverUrl,
    entities: {
      apps: { persistent: true, fields: ['id', 'name', 'worktree', 'branch', 'readme', 'accounts'] },
      proxies: { persistent: true, fields: ['id', 'appId', 'ruleset', 'proxyUrl'] },
      browserTpls: { persistent: true, path: '/_pwdev/browsers', fields: ['id', 'appId?', 'targetUrl?', 'brokerUrl?', 'profile?', 'proxyId?', 'ignoreSslErrors?', 'proxyBypassList?', 'headless?'] },
      sessions: { persistent: false, sourceOfTruth: 'broker', fields: ['sessionId', 'browserId?', 'appId?', 'browserInstanceId', 'cdpUrl'] },
    },
    endpoints: [
      { method: 'GET', path: '/_pwdev/status', summary: 'Server and broker health' },
      { method: 'GET', path: '/_pwdev/env', summary: 'Live runtime constants' },
      { method: 'GET', path: '/_pwdev/instructions', summary: 'Concise workflow guide' },
      { method: 'GET', path: '/_pwdev/api', summary: 'Compact API index; use a detail route or POST filter for usage' },
      { method: 'POST', path: '/_pwdev/api', summary: 'Find one operation by JSON { method, path }' },
      { method: 'GET|POST', path: '/_pwdev/apps', summary: 'Manage app metadata' },
      { method: 'GET|POST', path: '/_pwdev/browsers', summary: 'List or upsert browser templates', body: { required: ['id'], optional: ['appId', 'targetUrl', 'brokerUrl', 'profile', 'proxyId', 'ignoreSslErrors', 'proxyBypassList', 'headless', 'resetProfile'] } },
      { method: 'GET|DELETE', path: '/_pwdev/browsers/:id', summary: 'Get or delete browser template' },
      { method: 'POST', path: '/_pwdev/browsers/:id/start', summary: 'Start template; returns session and cdpUrl', body: { optional: ['sessionId', 'profile', 'ignoreSslErrors', 'proxyBypassList', 'headless', 'resetProfile'] } },
      { method: 'POST', path: '/_pwdev/browsers/:id/stop', summary: 'Stop default runtime or named session', body: { optional: ['sessionId'] } },
      { method: 'GET', path: '/_pwdev/sessions', summary: 'List live sessions' },
      { method: 'GET', path: '/_pwdev/sessions/:id', summary: 'Get live session' },
      { method: 'POST', path: '/_pwdev/sessions/:id/stop', summary: 'Stop live session' },
      { method: 'GET|POST|DELETE', path: '/_pwdev/proxies[/:id]', summary: 'Manage proxy records' },
      { method: 'GET', path: '/_pwdev/proxies/:id/traffic', summary: 'Read a Whistle proxy traffic feed', query: ['count', 'dumpCount', 'startTime', 'lastRowId', 'ids', 'status', 'url', 'ip', 'name', 'value', 'name1/value1…name5/value5', 'mtype'] },
      { method: 'ANY', path: '/_pwdev/proxy/*', summary: 'Server-proxied managed proxy API' },
      { method: 'ANY', path: '/_pwdev/broker/*', summary: 'Server-proxied broker API' },
    ],
    details: {
      resources: ['apps', 'browsers', 'proxies', 'sessions'],
      routeTemplate: '/_pwdev/api/:resource',
      lookup: {
        method: 'POST',
        path: '/_pwdev/api',
        body: { required: ['method', 'path'] },
        example: { method: 'POST', path: '/_pwdev/browsers/:id/start' },
      },
    },
    retired: ['/_pwdev/apps/:id/browser/*'],
  };
}

/** Handle compact API discovery, resource detail, and exact-operation lookup. */
async function handleApiRequest({ req, res, requestUrl, serverUrl, writeBody }) {
  const prefix = '/_pwdev/api';
  if (requestUrl.pathname === prefix) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      writeJson(res, 200, pwDevApi(serverUrl), writeBody);
      return;
    }
    if (req.method === 'POST') {
      const filter = await readJsonBody(req);
      const operation = findApiOperation(filter, serverUrl);
      writeJson(res, 200, { ok: true, serverUrl, operation }, writeBody);
      return;
    }
    res.writeHead(405, { allow: 'GET, HEAD, POST' });
    res.end('Method Not Allowed');
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }
  const resource = decodeURIComponent(requestUrl.pathname.slice(`${prefix}/`.length));
  const detail = pwDevApiDetails(serverUrl)[resource];
  if (!detail) {
    writeJson(res, 404, { ok: false, error: `Unknown pw-dev API resource: ${resource}` }, writeBody);
    return;
  }
  writeJson(res, 200, { ok: true, serverUrl, resource, ...detail }, writeBody);
}

function findApiOperation(filter, serverUrl) {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
    throwValidationError('API lookup filter must be an object');
  }
  const method = requiredString(filter.method, 'method').toUpperCase();
  const apiPath = requiredString(filter.path, 'path');
  if (!apiPath.startsWith('/_pwdev/')) {
    throwValidationError('path must start with /_pwdev/');
  }
  const operation = Object.values(pwDevApiDetails(serverUrl))
    .flatMap((detail) => detail.operations)
    .find((candidate) => candidate.method === method && candidate.path === apiPath);
  if (!operation) {
    const error = new Error(`No detailed API operation matches ${method} ${apiPath}`);
    error.statusCode = 404;
    throw error;
  }
  return operation;
}

function pwDevApiDetails(serverUrl) {
  const operation = (method, apiPath, summary, usage, example, restrictions, response) => ({
    method,
    path: apiPath,
    summary,
    usage,
    example,
    restrictions,
    response,
  });
  return {
    apps: {
      usage: 'Persisted project metadata. Register an app before linking it from a browser template.',
      operations: [
        operation('GET', '/_pwdev/apps', 'List registered apps', 'Fetch the central app registry.', { method: 'GET', path: '/_pwdev/apps' }, ['The root manifest is not an app unless explicitly registered.'], { fields: ['ok', 'apps'] }),
        operation('POST', '/_pwdev/apps', 'Create or update an app', 'Send an app record; id is the stable upsert key.', { method: 'POST', path: '/_pwdev/apps', body: { id: 'checkout-main', appUrl: 'http://127.0.0.1:5173', readme: 'Run npm run dev first.' } }, ['Do not register production or personal credentials in accounts.'], { fields: ['ok', 'app'] }),
        operation('GET', '/_pwdev/apps/:id', 'Get one app', 'Read metadata for one registered app.', { method: 'GET', path: '/_pwdev/apps/checkout-main' }, ['Returns 404 for an unknown id.'], { fields: ['ok', 'app'] }),
        operation('GET', '/_pwdev/apps/:id/manifest', 'Get an app manifest', 'Read the app attach contract and operating metadata.', { method: 'GET', path: '/_pwdev/apps/checkout-main/manifest' }, ['A manifest does not itself start a browser.'], { fields: ['ok', 'id', 'appUrl', 'readme'] }),
      ],
    },
    browsers: {
      usage: 'Persistent browser templates hold launch configuration; starting one creates a transient broker-owned session.',
      operations: [
        operation('GET', '/_pwdev/browsers', 'List browser templates', 'Fetch all persisted templates.', { method: 'GET', path: '/_pwdev/browsers' }, [], { fields: ['ok', 'browsers'] }),
        operation('POST', '/_pwdev/browsers', 'Create or update a browser template', 'Send id plus optional app, target, profile, registered proxy, and launch settings.', { method: 'POST', path: '/_pwdev/browsers', body: { id: 'checkout-tax', appId: 'checkout-main', targetUrl: 'http://127.0.0.1:5173', proxyId: 'checkout-whistle' } }, ['The broker resolves SSH-peer routing from its own topology when a proxy is selected.'], { fields: ['ok', 'browser'] }),
        operation('POST', '/_pwdev/browsers/:id/start', 'Start a browser session', 'Starts the template default session. Optionally supply sessionId for an isolated named session.', { method: 'POST', path: '/_pwdev/browsers/checkout-tax/start', body: { sessionId: 'smoke-1', ignoreSslErrors: true } }, ['Connect Playwright to response.session.cdpUrl; do not launch a separate browser.', 'sessionId uses a separate profile/runtime session.'], { fields: ['ok', 'browser', 'session'], session: ['sessionId', 'cdpUrl', 'browserInstanceId'] }),
        operation('POST', '/_pwdev/browsers/:id/stop', 'Stop a browser session', 'Stops the default session, or the named session in sessionId.', { method: 'POST', path: '/_pwdev/browsers/checkout-tax/stop', body: { sessionId: 'smoke-1' } }, ['Stopping a session does not delete its browser template.'], { fields: ['ok', 'sessionId'] }),
      ],
    },
    proxies: {
      usage: 'Proxy records are reusable metadata. Managed Whistle proxies also expose rules, lifecycle, GUI, and traffic capture through pw-dev.',
      operations: [
        operation('GET', '/_pwdev/proxies', 'List proxy records', 'Fetch registered and reconciled proxy metadata.', { method: 'GET', path: '/_pwdev/proxies' }, [], { fields: ['ok', 'proxies'] }),
        operation('POST', '/_pwdev/proxies', 'Create or update a proxy record', 'Send id and either proxyUrl or brokerProxyForwardId; guiUrl is optional metadata for Whistle.', { method: 'POST', path: '/_pwdev/proxies', body: { id: 'shared-whistle', kind: 'whistle', proxyUrl: 'http://127.0.0.1:8899' } }, ['proxyUrl and brokerProxyForwardId are mutually exclusive.', 'This does not start a proxy process.'], { fields: ['ok', 'proxy'] }),
        operation('GET', '/_pwdev/proxies/:id/traffic', 'Read Whistle captured traffic', 'Use dumpCount for a recent bounded snapshot, or poll with the previous traffic.data.lastId as startTime. url, ip, and request-header predicates filter candidates.', { method: 'GET', path: '/_pwdev/proxies/checkout-whistle/traffic?dumpCount=100&url=%2Fapi%2Forders&name=content-type&value=application%2Fjson&mtype=1' }, ['Requires a proxy record with guiUrl; otherwise returns 409.', 'Supported query fields: count, dumpCount, startTime, lastRowId, ids, status, url, ip, name/value through name5/value5, mtype.', 'mtype=1 makes request-header value matching exact. Method, status, and body filtering must be done by the agent after reading the feed.'], {
          fields: ['ok', 'proxyId', 'traffic'],
          cursor: 'traffic.data.lastId',
          example: {
            ok: true,
            proxyId: 'checkout-whistle',
            traffic: {
              ec: 0,
              data: {
                newIds: ['1720000000000-1'],
                lastId: '1720000000000-1',
                data: {
                  '1720000000000-1': {
                    id: '1720000000000-1',
                    url: 'https://api.example.test/orders',
                    method: 'POST',
                    req: { method: 'POST', headers: { 'content-type': 'application/json' } },
                    res: { statusCode: 201, headers: { 'content-type': 'application/json' } },
                  },
                },
              },
            },
          },
        }),
        operation('POST', '/_pwdev/proxy/proxies', 'Create a managed Whistle proxy', 'Send a ruleset and id or appId. The server lazily starts its proxy manager.', { method: 'POST', path: '/_pwdev/proxy/proxies', body: { id: 'checkout-whistle', taskId: 'smoke-login', ruleset: 'example.com 127.0.0.1:3000' } }, ['Use /_pwdev/proxy/* rather than the proxy-manager port.', 'Delete task-scoped proxies after the task.'], { fields: ['ok', 'proxy'] }),
      ],
    },
    sessions: {
      usage: 'Live, broker-owned runtime records. They are removed after broker restart or explicit stop.',
      operations: [
        operation('GET', '/_pwdev/sessions', 'List live sessions', 'Fetch and reconcile active broker sessions.', { method: 'GET', path: '/_pwdev/sessions' }, [], { fields: ['ok', 'sessions'] }),
        operation('POST', '/_pwdev/sessions/:id/stop', 'Stop a live session', 'Stop directly by session id when the originating template is not convenient.', { method: 'POST', path: '/_pwdev/sessions/checkout-tax__default/stop' }, ['Does not delete the persistent browser template.'], { fields: ['ok', 'sessionId'] }),
      ],
    },
  };
}

function pwDevInstructions(serverUrl) {
  return `# pw-dev agent instructions

Use only this server's \`/_pwdev/*\` APIs. Do not call broker or proxy-manager
ports directly.

## Discover

\`\`\`bash
curl '${serverUrl}/_pwdev/status'
curl '${serverUrl}/_pwdev/openapi.json'
\`\`\`

\`status\` reports broker reachability. The root OpenAPI document is a compact
catalog: read its \`x-pwdev-documents\` list, then fetch only the domain document
needed next (for example \`/_pwdev/openapi/browsers.json\` or
\`/_pwdev/openapi/proxies.json\`). \`env\` is optional runtime-path discovery for
shell/external tooling; fetch it again after a server restart.

For managed-proxy lifecycle or rules, first fetch \`GET /_pwdev/delegates\` and
then the proxy delegate's linked OpenAPI document. The server republishes that
component-owned contract under \`/_pwdev/proxy/*\`; do not call its internal port.

## Inspect managed-proxy traffic

Traffic guidance is in \`/_pwdev/openapi/proxies/traffic.json\`. Fetch that leaf
document directly when traffic is all that is needed:

\`\`\`bash
curl -sS "$PW_DEV_URL/_pwdev/openapi/proxies/traffic.json"
\`\`\`

## Persisted entities

- **app**: project metadata, \`readme\`, accounts, and worktree. An app can be
  linked from a browser but does not own browser lifecycle.
- **proxy**: reusable proxy configuration; managed proxy rules/profile state are
  retained by the proxy manager.
- **browserTpl**: reusable launch template. Fields include \`id\`, optional
  \`appId\`, \`targetUrl\`, \`brokerUrl\`, \`profile\`, \`proxyId\`,
  \`proxyBypassList\`, \`ignoreSslErrors\`, and \`headless\`.

## Start and use a browser

Create or update a template with \`POST /_pwdev/browsers\`. Start the default
session without a payload, or start an isolated concurrent session with a
\`sessionId\` (which receives its own profile by default):

\`\`\`js
const started = await fetch('${serverUrl}/_pwdev/browsers/docs-crawler/start', {
  method: 'POST',
}).then((response) => response.json());

const browser = await chromium.connectOverCDP(started.session.cdpUrl);
// Navigate to the template's targetUrl when one is configured.
\`\`\`

For parallel work, send \`{ "sessionId": "shard-1" }\` to start and stop:
\`POST /_pwdev/browsers/:id/start\` and
\`POST /_pwdev/browsers/:id/stop\`. Named sessions are transient and appear
in \`GET /_pwdev/sessions\`.

The response creates a transient **session**. Broker state is authoritative;
the server removes a session when broker status no longer reports its instance.
Stop with \`POST /_pwdev/browsers/:id/stop\` or
\`POST /_pwdev/sessions/:id/stop\`. Detach Playwright with \`browser.close()\`
when automation ends; that disconnects the client without stopping the instance.

For a remote SSH broker and a selected \`proxyId\`, pw-dev asks the broker to
create/reuse the required mapping. Do not create proxy forwards yourself.

## Example workflows

### App-based

1. Register the app with \`POST /_pwdev/apps\`. Put operational guidance in
   \`readme\`: devserver start/stop commands, environment setup, and the proxy
   rule template plus its compose/compile method.
2. Read that app \`readme\`, compose the rules, then create a managed proxy with
   \`POST /_pwdev/proxy/proxies\` and \`appId\`.
3. Create a browser template with \`POST /_pwdev/browsers\`, using \`appId\`
   and the returned \`proxyId\`.
4. Start it with \`POST /_pwdev/browsers/:id/start\`; attach Playwright to the
   returned session \`cdpUrl\`.

### Standalone

1. Create a managed proxy with \`POST /_pwdev/proxy/proxies\` and no \`appId\`.
2. Create a browser template with \`targetUrl\` and that \`proxyId\`.
3. Start it with \`POST /_pwdev/browsers/:id/start\`; attach Playwright to the
   returned session \`cdpUrl\`.

## API index

\`\`\`text
GET|POST /_pwdev/apps
GET|DELETE /_pwdev/apps/:id
GET|POST /_pwdev/browsers
GET|DELETE /_pwdev/browsers/:id
POST       /_pwdev/browsers/:id/start
POST       /_pwdev/browsers/:id/stop
GET        /_pwdev/sessions
GET        /_pwdev/sessions/:id
POST       /_pwdev/sessions/:id/stop
GET|POST   /_pwdev/proxies
GET|DELETE /_pwdev/proxies/:id
GET        /_pwdev/proxies/:id/traffic
ANY        /_pwdev/proxy/*
ANY        /_pwdev/broker/*
\`\`\`

App-scoped \`/_pwdev/apps/:id/browser/*\` routes are retired.
`;

  const skillPath = path.join(process.cwd(), '.claude', 'skills', 'playwright-cli', 'SKILL.md');
  const skillSection = existsSync(skillPath)
    ? `## Browser-automation command reference (read this file)

The bundled \`playwright-cli\` skill is a plain-text command reference. Read it
directly for the full command set (open/goto/click/snapshot/network/tracing/…);
you do not need it registered as a skill to use it:

\`\`\`text
${skillPath}
\`\`\`

Its \`references/\` directory (same folder) holds deeper guides. Drive the
browser via the \`playwright-cli\` binary as documented there.

`
    : `## Browser-automation command reference

The bundled \`playwright-cli\` skill is not installed in this workspace. To get
the plain-text command reference at
\`${skillPath}\`, run \`npm run install:playwright\`.

`;
  return `# pw-dev agent instructions

Use this server as the control plane for app discovery, browser lifecycle, and
broker-proxied CDP. Agents should not need the broker URL directly.

${skillSection}## Environment constants (external / shell scripts)

\`GET /_pwdev/env\` returns the live constants (server URL, broker proxy path,
bundled skill path, resolved Chromium executable) as JSON. Node clients can just
fetch it; non-Node/shell consumers should request the shell-export form and
\`eval\` it — the values track the running server, so re-run it after a restart:

\`\`\`bash
eval "$(curl -s '${serverUrl}/_pwdev/env?format=sh')"
# now $PW_DEV_URL, $PW_DEV_BROKER_PROXY, $PW_DEV_PLAYWRIGHT,
# $PW_DEV_PLAYWRIGHT_CLI, $PW_SKILL_PATH, $PW_CHROMIUM_PATH, … are set
\`\`\`

Do not persist these into a static file; fetch them from the running server so
they never go stale or collide across concurrent server instances.

## Discover server and broker state

\`\`\`js
const status = await fetch('${serverUrl}/_pwdev/status')
  .then((response) => response.json());

if (!status.broker?.configured) {
  throw new Error('pw-dev broker status is unavailable');
}

function pwDevApi(serverUrl) {
  return {
    ok: true,
    version: 1,
    serverUrl,
    entities: {
      apps: { persistent: true, fields: ['id', 'name', 'worktree', 'branch', 'readme', 'accounts'] },
      networks: { persistent: true, fields: ['id', 'proxy', 'browser'] },
      proxies: { persistent: true, fields: ['id', 'appId', 'ruleset', 'proxyUrl'] },
      browsers: { persistent: true, fields: ['id', 'appId?', 'targetUrl?', 'brokerUrl?', 'profile?', 'networkId?', 'proxyId?', 'ignoreSslErrors?', 'headless?'] },
      sessions: { persistent: false, sourceOfTruth: 'broker', fields: ['sessionId', 'browserId?', 'appId?', 'browserInstanceId', 'cdpUrl'] },
    },
    endpoints: [
      { method: 'GET', path: '/_pwdev/status', summary: 'Server and broker health' },
      { method: 'GET', path: '/_pwdev/env', summary: 'Live runtime constants' },
      { method: 'GET', path: '/_pwdev/instructions', summary: 'Concise workflow guide' },
      { method: 'GET', path: '/_pwdev/apps', summary: 'List apps' },
      { method: 'POST', path: '/_pwdev/apps', summary: 'Create or update app metadata' },
      { method: 'GET', path: '/_pwdev/browsers', summary: 'List persisted browser templates' },
      { method: 'POST', path: '/_pwdev/browsers', summary: 'Create or update browser template', body: { required: ['id'], optional: ['appId', 'targetUrl', 'brokerUrl', 'profile', 'networkId', 'proxyId', 'ignoreSslErrors', 'proxyBypassList', 'headless', 'resetProfile'] } },
      { method: 'GET', path: '/_pwdev/browsers/:id', summary: 'Get template and current runtime session' },
      { method: 'DELETE', path: '/_pwdev/browsers/:id', summary: 'Delete template' },
      { method: 'POST', path: '/_pwdev/browsers/:id/start', summary: 'Start template; no request body; returns session and cdpUrl' },
      { method: 'POST', path: '/_pwdev/browsers/:id/stop', summary: 'Stop template runtime session' },
      { method: 'GET', path: '/_pwdev/sessions', summary: 'List live sessions' },
      { method: 'GET', path: '/_pwdev/sessions/:id', summary: 'Get live session' },
      { method: 'POST', path: '/_pwdev/sessions/:id/stop', summary: 'Stop live session' },
      { method: 'GET|POST|DELETE', path: '/_pwdev/networks[/:id]', summary: 'Manage persisted network templates' },
      { method: 'GET|POST|DELETE', path: '/_pwdev/proxies[/:id]', summary: 'Manage proxy records' },
      { method: 'ANY', path: '/_pwdev/proxy/*', summary: 'Server-proxied managed proxy API' },
      { method: 'ANY', path: '/_pwdev/broker/*', summary: 'Server-proxied broker API' },
    ],
    retired: ['/_pwdev/apps/:id/browser/*'],
  };
}

if (status.broker.reachable === false) {
  throw new Error(\`pw-dev broker is unreachable: \${status.broker.error}\`);
}

if (status.broker.status?.topology?.remote && status.broker.status.topology.mode === 'ssh') {
  // A selected proxyId is mapped by the broker automatically. Agents must not
  // create or choose proxy forwards/ports.
}
\`\`\`

## List and select apps

Only explicitly registered apps appear in \`/_pwdev/apps\`. The server root
manifest remains available at \`/_pwdev/manifest\`, but it is not registered as
an app unless the server was started with \`--register-default-app\`.

\`\`\`js
const { apps } = await fetch('${serverUrl}/_pwdev/apps')
  .then((response) => response.json());

const app = apps.find((candidate) => candidate.id === 'checkout-tax');
\`\`\`

## List sessions

Sessions are first-class server resources. App reads still project active
session data for convenience, but \`/_pwdev/sessions\` is the canonical lookup
surface for session id, task, broker instance, and CDP URL.

\`\`\`js
const { sessions } = await fetch('${serverUrl}/_pwdev/sessions')
  .then((response) => response.json());

const session = sessions.find((candidate) => candidate.sessionId === 'checkout-tax__smoke-login-20260629');
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
    readme: 'Run npm run dev before testing. Copy .env.example to .env.local; ask before changing shared staging data.',
    accounts: {
      login: {
        usr: 'xxx',
        pwd: 'xxx',
      },
    },
    proxyId: 'whistle-main',
  }),
});
\`\`\`

Use \`readme\` for concise app-specific agent instructions: how to start or
stop devserver(s), required environment variables or local setup, test-data
constraints, and task precautions. When the app uses a managed proxy, include
the proxy-rule template path, the command or method that composes/compiles the
ruleset, its required inputs, and how to apply the result through the
server-proxied proxy API. Only register non-production test accounts in
\`accounts\`. Do not put production accounts, personal credentials, or
sensitive tokens in app metadata.

## Persisted browser templates

Use browser templates for a reusable browser target. Templates are persisted by
the server; their live broker instance is transient, so start the same template
again after a broker restart. \`appId\` is optional: use it to link an app's
instructions, accounts, and defaults. Omit it for a crawler or generic browser
and supply \`targetUrl\` instead.

\`brokerUrl\` is optional and selects the configured server broker when absent.
\`networkId\`, \`proxyId\`, profile, and launch settings are template fields;
the start request normally has no body.

\`\`\`js
const browser = await fetch('${serverUrl}/_pwdev/browsers', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    id: 'docs-crawler',
    targetUrl: 'https://example.com/docs',
    brokerUrl: 'http://127.0.0.1:18080',
    profile: 'docs-crawler',
    headless: true,
  }),
}).then((response) => response.json());

const startedBrowser = await fetch('${serverUrl}/_pwdev/browsers/docs-crawler/start', {
  method: 'POST',
}).then((response) => response.json());
// Attach Playwright to startedBrowser.start.cdpUrl.
\`\`\`

Endpoints:

\`\`\`text
GET|POST /_pwdev/browsers
GET|DELETE /_pwdev/browsers/:id
POST /_pwdev/browsers/:id/start
POST /_pwdev/browsers/:id/stop
\`\`\`

## Branch/app lifecycle guidelines

- Treat each development branch or app registration as its own lifecycle
  boundary. Register an app with that branch's \`worktree\`, and use that app id
  for all tasks against that branch.
- Before starting a browser template, stop its existing live session or use a
  distinct browser template/profile for parallel work. Start templates through
  \`POST /_pwdev/browsers/:id/start\`.
- The server automatically reconciles session liveness against broker status on
  session and app reads. If a broker restart loses an instance, stale session
  records are removed automatically instead of requiring a manual cleanup pass.
- Create a dedicated managed proxy for the branch/app when proxying is needed.
  Wire that proxy to a browser template through its \`proxyId\`.
- When work is finished, stop the browser template and delete task-scoped
  managed proxies. Keep persistent broker profiles only when their login/session
  state is intentionally reusable.

## Playwright clients

There are two supported ways to run Playwright against a pw-dev browser:

1. Use the Playwright package, CLI, and bundled skills installed in the pw-dev
   workspace. Generated task code should live inside pw-dev. They are installed
   by \`npm install\`; run \`npm run install:playwright\` to repeat that setup.
2. Use a Playwright installation owned by the client agent. The agent can run
   scripts from its own workspace and attach to the pw-dev broker session using
   the returned \`cdpUrl\`.

In both modes, attach to the existing browser; do not launch a separate one.
After the script finishes, detach without stopping the broker-owned browser:

\`\`\`js
const browser = await chromium.connectOverCDP(cdpUrl);
try {
  // Run the agent's Playwright task here.
} finally {
  // For a browser connected over CDP, close() disconnects this client.
  await browser.close();
}
\`\`\`

Use the server browser/session stop endpoint separately when the task's browser
session should actually be stopped.

Default location for generated pw-dev Playwright scripts and artifacts:

\`\`\`text
.agent/tasks/<task-id>/run.mjs
.agent/tasks/<task-id>/artifacts/
\`\`\`

The script may be copied elsewhere if you want to run it against another
Playwright install or keep it outside pw-dev. The artifacts directory is for
outputs produced by that run.

In generated task code, import Playwright normally and connect to pw-dev's CDP
URL. Do not launch a separate browser:

\`\`\`js
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP(cdpUrl);
\`\`\`

## Start browser and attach Playwright

\`\`\`js
const started = await fetch('${serverUrl}/_pwdev/browsers/checkout-tax/start', {
  method: 'POST',
}).then((response) => response.json());

const { browser: template } = await fetch('${serverUrl}/_pwdev/browsers/checkout-tax')
  .then((response) => response.json());

const cdpUrl = started.session.cdpUrl;
const browser = await chromium.connectOverCDP(cdpUrl);
const context = browser.contexts()[0];
const page = context.pages()[0] ?? await context.newPage();
if (template.targetUrl) await page.goto(template.targetUrl);
\`\`\`

The session \`cdpUrl\` points at \`/_pwdev/broker/*\`, which proxies broker
HTTP and WebSocket traffic through this server.

## Stop browser

\`\`\`js
await fetch('${serverUrl}/_pwdev/browsers/checkout-tax/stop', {
  method: 'POST',
});
\`\`\`

Or stop by session id directly:

\`\`\`js
await fetch('${serverUrl}/_pwdev/sessions/checkout-tax__default/stop', {
  method: 'POST',
});
\`\`\`

## Create a managed Whistle proxy

The normal \`pw-dev server\` command starts the local proxy manager lazily on
the first server-proxied proxy operation and stops it with the server. Use the
server-proxied API; agents do not need the proxy manager port directly. Send a
ready-to-apply \`ruleset\`;
pw-dev creates a Whistle instance with separate proxy and GUI ports, registers
it under \`/_pwdev/proxies\`, and starts it with HTTPS capture enabled
(\`Enable HTTPS / Capture Tunnel Traffic\`), and attaches it to \`appId\` when
provided.

If the server was started with \`--no-proxy-manager\`, configure an external
manager with \`--proxy-manager-url\` before using these routes.

Create requires \`ruleset\` and either \`id\` or \`appId\`. If only \`appId\`
is supplied, the proxy id defaults to \`<appId>-whistle\`.

Most managed proxies should be task-scoped: create one for a specific
test/verification, start the browser with that \`proxyId\`, and delete the proxy
when the task ends. Use \`taskId\`, \`owner\`, \`purpose\`, and \`labels\` to
track why the proxy exists, and compose the \`ruleset\` for the debugging job
at hand: point app traffic at a GUI devserver, mock API responses, inject
local code, or combine those behaviors in one task-scoped proxy.

Managed proxies expose live rules state at \`proxy.rules\`. Rules replacement is
full-state and uses \`PUT /_pwdev/proxy/proxies/:id/rules\`; send the complete
default and override rulesets together with \`baseVersion\`. Read the current
\`proxy.rules\`, compute the desired replacement, and write it in place. The
running proxy and browser do not need to be rebuilt. Use \`baseVersion\` to avoid
lost updates.

\`\`\`js
const managedProxy = await fetch('${serverUrl}/_pwdev/proxy/proxies', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    id: 'checkout-tax-whistle',
    taskId: 'smoke-login-20260629',
    owner: 'codex',
    purpose: 'Smoke login API rewrite',
    labels: ['smoke', 'verification'],
    ruleset: 'example.com 127.0.0.1:3000',
  }),
}).then((response) => response.json());

// Shared proxies do not need appId. Pass the returned id into each browser
// start that should use this proxy. Supplying appId during create is only a
// convenience that patches that app's proxyId for you.
const proxiedStart = await fetch('${serverUrl}/_pwdev/apps/checkout-tax/browser/start', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    proxyId: managedProxy.proxy.id,
    task: { id: 'smoke-login-20260629', owner: 'codex' },
  }),
}).then((response) => response.json());

const proxyStatus = await fetch('${serverUrl}/_pwdev/proxy/status')
  .then((response) => response.json());

// Managed proxy configuration is retained in its Whistle profile. Stop,
// start, or restart it through pw-dev; never use the manager port directly.
await fetch('${serverUrl}/_pwdev/proxy/proxies/checkout-tax-whistle/restart', {
  method: 'POST',
});

const currentProxy = await fetch('${serverUrl}/_pwdev/proxy/proxies/checkout-tax-whistle')
  .then((response) => response.json());

// Example: replace the complete rules state on the running proxy.
const updatedProxy = await fetch('${serverUrl}/_pwdev/proxy/proxies/checkout-tax-whistle/rules', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    baseVersion: currentProxy.proxy.rules.version,
    defaultRuleset: currentProxy.proxy.rules.defaultRuleset,
    overrideRuleset: 'example.com/api/orders/preview resBody://{ "ok": true, "source": "mock" }',
  }),
}).then((response) => response.json());
\`\`\`

## Create and use a broker network

Networks are broker-owned browser routing profiles. Use \`networkId\` in browser
start requests instead of creating proxy forwards directly.

For normal managed-proxy starts, use \`proxyId\` instead. If the selected broker
reports SSH remote topology, it automatically creates or reuses the SSH mapping
to that proxy on its peer. \`proxyForwardId\` and mapped ports are broker
internals, exposed only on the resulting session for diagnostics.

When the broker topology reports \`remote: true\` with \`mode: "ssh"\`, prefer a
mapped proxy network for agent-local debugging traffic. Typical flow:

1. Create a managed Whistle proxy with a task-specific \`ruleset\`.
2. Read the returned \`proxyUrl\` and use its port as \`proxy.remotePort\`.
3. Create \`/_pwdev/networks\` with \`proxy.mode: "ssh-peer"\`.
4. Start the browser with \`networkId\`.

That lets the remote broker browser reach an agent-local proxy for GUI
devserver tapping, API mocking, code injection, and similar debugging work.

\`\`\`js
const network = await fetch('${serverUrl}/_pwdev/networks', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    id: 'agent-whistle',
    kind: 'whistle',
    proxy: { mode: 'ssh-peer', remotePort: 8899 },
    browser: { ignoreSslErrors: true },
  }),
}).then((response) => response.json());

const startedWithNetwork = await fetch('${serverUrl}/_pwdev/apps/checkout-tax/browser/start', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    networkId: network.network.id,
    task: { id: 'smoke-login-20260629', owner: 'codex' },
  }),
}).then((response) => response.json());
\`\`\`

Use \`proxy.mode: "ssh-peer"\` when the proxy is on the SSH peer configured by
broker \`--ssh\`. Set \`proxy.remotePort\` to the Whistle port on that SSH peer;
set \`proxy.localPort\` only if you need a fixed broker-side forwarded port.
Use \`"direct"\` or \`"broker-local"\` when the proxy URL is already reachable
from the broker/Chrome host.

## Create and remove a broker proxy forward

This is the lower-level API behind \`proxy.mode: "ssh-peer"\` networks. Prefer
\`/_pwdev/networks\` for normal agent workflows. The broker must have been
started with \`--ssh\`.

\`\`\`js
const forward = await fetch('${serverUrl}/_pwdev/broker/proxy-forwards', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'checkout-tax-whistle',
    remotePort: 8899,
    localPort: 18899,
  }),
}).then((response) => response.json());

await fetch('${serverUrl}/_pwdev/proxies', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    id: 'checkout-tax-broker-whistle',
    kind: 'whistle',
    name: 'Checkout tax Whistle via broker SSH forward',
    brokerProxyForwardId: forward.forwardId,
  }),
});

const startedWithForward = await fetch('${serverUrl}/_pwdev/apps/checkout-tax/browser/start', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    proxyId: 'checkout-tax-broker-whistle',
    ignoreSslErrors: true,
    task: { id: 'smoke-login-20260629', owner: 'codex' },
  }),
}).then((response) => response.json());
\`\`\`

Remove the forward after stopping every browser session that uses it. The broker
returns \`409 Conflict\` if the forward is still in use.

\`\`\`js
await fetch('${serverUrl}/_pwdev/apps/checkout-tax/browser/stop', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ taskId: 'smoke-login-20260629' }),
});

await fetch(\`${serverUrl}/_pwdev/broker/proxy-forwards/\${encodeURIComponent(forward.forwardId)}\`, {
  method: 'DELETE',
});
\`\`\`

Delete task-scoped managed proxies when the task ends:

\`\`\`js
await fetch('${serverUrl}/_pwdev/proxy/proxies/checkout-tax-whistle', {
  method: 'DELETE',
});
\`\`\`

## Endpoints

\`\`\`text
GET    /_pwdev/status
GET    /_pwdev/env
GET    /_pwdev/instructions
GET    /_pwdev/api
POST   /_pwdev/api
GET    /_pwdev/api/:resource
GET    /_pwdev/client.js
GET    /_pwdev/proxies
POST   /_pwdev/proxies
GET    /_pwdev/proxies/:id
DELETE /_pwdev/proxies/:id
GET    /_pwdev/proxies/:id/traffic
GET    /_pwdev/networks
POST   /_pwdev/networks
GET    /_pwdev/networks/:id
DELETE /_pwdev/networks/:id
POST   /_pwdev/networks/:id/check
GET    /_pwdev/sessions
GET    /_pwdev/sessions/:id
POST   /_pwdev/sessions/:id/stop
GET    /_pwdev/apps
POST   /_pwdev/apps
GET    /_pwdev/apps/:id
DELETE /_pwdev/apps/:id
GET    /_pwdev/apps/:id/manifest
GET    /_pwdev/browsers
POST   /_pwdev/browsers
GET    /_pwdev/browsers/:id
DELETE /_pwdev/browsers/:id
POST   /_pwdev/browsers/:id/start
POST   /_pwdev/browsers/:id/stop
ANY    /_pwdev/broker/*
GET    /_pwdev/proxy/status
GET    /_pwdev/proxy/proxies
POST   /_pwdev/proxy/proxies
GET    /_pwdev/proxy/proxies/:id
PUT    /_pwdev/proxy/proxies/:id/rules
DELETE /_pwdev/proxy/proxies/:id
POST   /_pwdev/proxy/proxies/:id/stop
POST   /_pwdev/proxy/stop-all
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

export async function listPwDevSessions({ serverUrl = '${serverUrl}' } = {}) {
  const response = await fetch(\`\${serverUrl}/_pwdev/sessions\`);
  if (!response.ok) {
    throw new Error(\`pw-dev sessions failed: \${response.status} \${await response.text()}\`);
  }
  return response.json();
}

export async function loadPwDevSession(sessionId, { serverUrl = '${serverUrl}' } = {}) {
  if (!sessionId) throw new Error('loadPwDevSession requires sessionId');
  const response = await fetch(\`\${serverUrl}/_pwdev/sessions/\${encodeURIComponent(sessionId)}\`);
  if (!response.ok) {
    throw new Error(\`pw-dev session load failed: \${response.status} \${await response.text()}\`);
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

export async function loadPwDevProxyManagerStatus({ serverUrl = '${serverUrl}' } = {}) {
  const response = await fetch(\`\${serverUrl}/_pwdev/proxy/status\`);
  if (!response.ok) {
    throw new Error(\`pw-dev proxy status failed: \${response.status} \${await response.text()}\`);
  }
  return response.json();
}

export async function createPwDevManagedProxy(proxy, { serverUrl = '${serverUrl}' } = {}) {
  const response = await fetch(\`\${serverUrl}/_pwdev/proxy/proxies\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(proxy),
  });
  if (!response.ok) {
    throw new Error(\`pw-dev managed proxy create failed: \${response.status} \${await response.text()}\`);
  }
  return response.json();
}

export async function loadPwDevManagedProxy(proxyId, { serverUrl = '${serverUrl}' } = {}) {
  const response = await fetch(\`\${serverUrl}/_pwdev/proxy/proxies/\${encodeURIComponent(proxyId)}\`);
  if (!response.ok) {
    throw new Error(\`pw-dev managed proxy load failed: \${response.status} \${await response.text()}\`);
  }
  return response.json();
}

export async function replacePwDevManagedProxyRules(proxyId, rules, { serverUrl = '${serverUrl}' } = {}) {
  const response = await fetch(\`\${serverUrl}/_pwdev/proxy/proxies/\${encodeURIComponent(proxyId)}/rules\`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rules),
  });
  if (!response.ok) {
    throw new Error(\`pw-dev managed proxy rules replacement failed: \${response.status} \${await response.text()}\`);
  }
  return response.json();
}

export async function deletePwDevManagedProxy(proxyId, { serverUrl = '${serverUrl}' } = {}) {
  const response = await fetch(\`\${serverUrl}/_pwdev/proxy/proxies/\${encodeURIComponent(proxyId)}\`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error(\`pw-dev managed proxy delete failed: \${response.status} \${await response.text()}\`);
  }
  return response.json();
}

export async function createPwDevBrokerNetwork(network, { serverUrl = '${serverUrl}' } = {}) {
  const response = await fetch(\`\${serverUrl}/_pwdev/networks\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(network),
  });
  if (!response.ok) {
    throw new Error(\`pw-dev network create failed: \${response.status} \${await response.text()}\`);
  }
  return response.json();
}

export async function loadPwDevBrokerNetworks({ serverUrl = '${serverUrl}' } = {}) {
  const response = await fetch(\`\${serverUrl}/_pwdev/networks\`);
  if (!response.ok) {
    throw new Error(\`pw-dev networks load failed: \${response.status} \${await response.text()}\`);
  }
  return response.json();
}

export async function checkPwDevBrokerNetwork(networkId, { serverUrl = '${serverUrl}', ...probe } = {}) {
  const response = await fetch(\`\${serverUrl}/_pwdev/networks/\${encodeURIComponent(networkId)}/check\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(probe),
  });
  if (!response.ok) {
    throw new Error(\`pw-dev network check failed: \${response.status} \${await response.text()}\`);
  }
  return response.json();
}

export function pwDevAgentTaskPaths(taskId, { root = '.agent/tasks' } = {}) {
  if (!taskId) throw new Error('pwDevAgentTaskPaths requires taskId');
  const safeTaskId = String(taskId).replace(/[^A-Za-z0-9._-]/g, '_');
  const dir = \`\${root}/\${safeTaskId}\`;
  return {
    taskId: safeTaskId,
    dir,
    script: \`\${dir}/run.mjs\`,
    artifactsDir: \`\${dir}/artifacts\`,
  };
}

export function pwDevPlaywrightImportHint() {
  return "Run generated task scripts inside the pw-dev workspace and import { chromium } from 'playwright'. npm install enables the Playwright package, CLI, Chromium browser, and bundled probing skills; run npm run install:playwright to repeat that setup.";
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

export async function upsertPwDevBrowser(template, { serverUrl = '${serverUrl}' } = {}) {
  if (!template?.id) throw new Error('upsertPwDevBrowser requires template.id');
  const response = await fetch(\`\${serverUrl}/_pwdev/browsers\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(template),
  });
  if (!response.ok) throw new Error(\`pw-dev browser template upsert failed: \${response.status} \${await response.text()}\`);
  return response.json();
}

export async function loadPwDevBrowser({ serverUrl = '${serverUrl}', browserId } = {}) {
  if (!browserId) throw new Error('loadPwDevBrowser requires browserId');
  const response = await fetch(\`\${serverUrl}/_pwdev/browsers/\${encodeURIComponent(browserId)}\`);
  if (!response.ok) throw new Error(\`pw-dev browser template load failed: \${response.status} \${await response.text()}\`);
  return response.json();
}

export async function startPwDevBrowser({ serverUrl = '${serverUrl}', browserId } = {}) {
  if (!browserId) throw new Error('startPwDevBrowser requires browserId');
  const response = await fetch(\`\${serverUrl}/_pwdev/browsers/\${encodeURIComponent(browserId)}/start\`, { method: 'POST' });
  if (!response.ok) throw new Error(\`pw-dev browser start failed: \${response.status} \${await response.text()}\`);
  return response.json();
}

export async function stopPwDevBrowser({ serverUrl = '${serverUrl}', browserId } = {}) {
  if (!browserId) throw new Error('stopPwDevBrowser requires browserId');
  const response = await fetch(\`\${serverUrl}/_pwdev/browsers/\${encodeURIComponent(browserId)}/stop\`, { method: 'POST' });
  if (!response.ok) throw new Error(\`pw-dev browser stop failed: \${response.status} \${await response.text()}\`);
  return response.json();
}

export async function stopPwDevSession({ serverUrl = '${serverUrl}', sessionId } = {}) {
  if (!sessionId) throw new Error('stopPwDevSession requires sessionId');
  const response = await fetch(\`\${serverUrl}/_pwdev/sessions/\${encodeURIComponent(sessionId)}/stop\`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(\`pw-dev session stop failed: \${response.status} \${await response.text()}\`);
  }
  return response.json();
}

export async function connectPwDev({ serverUrl = '${serverUrl}', browserId, chromium, startBrowser = true } = {}) {
  if (!chromium) {
    throw new Error('connectPwDev requires a Playwright chromium object');
  }

  await assertPwDevReady({ serverUrl });
  if (!browserId) {
    throw new Error('connectPwDev requires browserId');
  }

  const result = startBrowser
    ? await startPwDevBrowser({ serverUrl, browserId })
    : await loadPwDevBrowser({ serverUrl, browserId });
  const template = result.browser ?? result;
  const session = result.session ?? template.runtime;
  if (!session?.cdpUrl) {
    throw new Error('pw-dev browser has no live session cdpUrl');
  }

  const browser = await chromium.connectOverCDP(session.cdpUrl);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.newPage();

  return { template, session, browser, context, page };
}
`;
}
