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
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRemoteBrokerManager } from './remote-brokers.js';

const require = createRequire(import.meta.url);
const SERVER_PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PROXY_PACKAGE_ROOT = path.resolve(SERVER_PACKAGE_ROOT, '..', 'proxy');
const BROKER_PACKAGE_ROOT = path.resolve(SERVER_PACKAGE_ROOT, '..', 'cdp-broker');
const INSTRUCTION_TEMPLATE_ROOT = path.join(SERVER_PACKAGE_ROOT, 'instructions');

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
const DEFAULT_SESSION_LEASE_TTL_MS = 30_000;
const MAX_SESSION_LEASE_TTL_MS = 60 * 60 * 1000;

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
 * @property {string=} browserConfigRegistryFile Durable browser config JSON path. Defaults to `<worktree>/.pw-dev/browser-configs.json`.
 * @property {boolean=} registerDefaultApp Register the root manifest in `/_pwdev/apps`. Defaults to false.
 * @property {string=} browserRegistryFile Durable browser JSON path. Defaults to `<worktree>/.pw-dev/browsers.json`.
 * @property {{ list: () => unknown[], provision: (request: Record<string, unknown>) => Promise<unknown>, remove: (id: string) => Promise<boolean>, stop: (id: string) => Promise<boolean>, close: () => Promise<void> }=} remoteBrokerManager Server-owned remote broker provisioner. Primarily useful for embedding and tests.
 */

/**
 * App manifest returned from `/_pwdev/manifest` and
 * `/_pwdev/apps/:id/manifest`.
 *
 * Agents should treat `appUrl` and a browser CDP URL as the primary attach
 * contract: load the app at `appUrl`, and connect Playwright over app `cdpUrl`
 * for the default browser slot or `browserSessions[sessionId].cdpUrl` for a
 * isolated named browser session.
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
 * @property {Record<string, PwDevBrowserSession>=} browserSessions Named browser sessions for parallel app work.
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
 * External records are reusable routing metadata. Managed records mirror the
 * durable Whistle profile and can include current process state. Apps should
 * reference a proxy by `proxyId` instead of duplicating proxy details.
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
 * @property {boolean=} running Current managed Whistle process state; not persisted by the server mirror.
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
 * Durable reusable browser suite.
 *
 * @typedef {object} PwDevBrowser
 * @property {string} id Stable browser id.
 * @property {string=} name Human-readable name.
 * @property {string=} readme Workflow-specific agent instructions.
 * @property {string} browserConfigId Required reusable browser config.
 * @property {string=} appId Optional app reference.
 * @property {string=} proxyId Fixed or currently selected reserved proxy.
 * @property {string[]=} proxyIds Optional pool used for automatic selection.
 * @property {string=} profile Stable derived or explicitly overridden Chrome profile.
 * @property {string=} sessionId Current transient session id.
 * @property {PwDevSessionLease=} lease Agent lease identifying the current Playwright owner.
 * @property {string=} createdAt Registry creation timestamp.
 * @property {string=} updatedAt Registry update timestamp.
 */

/**
 * @typedef {object} PwDevBrowserRegistry
 * @property {() => PwDevBrowser[]} list
 * @property {(id: string) => (PwDevBrowser | undefined)} get
 * @property {(raw: Record<string, unknown>) => PwDevBrowser} upsert
 * @property {(id: string, patch: Record<string, unknown>) => (PwDevBrowser | undefined)} update
 * @property {(id: string) => boolean} delete
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
 * @property {string=} browserId Durable browser that owns this session.
 * @property {string=} browserConfigId Browser config used to launch the session.
 * @property {string=} appId App associated with this session.
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
 * @property {{ proxyId: string, sessionId: string, leasedAt: string, trafficStartTime: string }=} proxyLease Exclusive proxy-pool lease and Whistle traffic cursor held for this session.
 * @property {string=} proxyForwardId Broker proxy-forward id associated with the session.
 * @property {string=} proxyServer Explicit Chrome proxy server URL associated with the session.
 * @property {PwDevSessionLease=} lease Agent lease identifying the current Playwright owner.
 */

/**
 * A short-lived agent lease for a browser session. The lease is separate from
 * the browser session itself: expiry makes the session claimable again but
 * does not stop Chrome.
 *
 * @typedef {object} PwDevSessionLease
 * @property {string} leaseId Opaque token required for heartbeat and release.
 * @property {string} owner Agent/user/tool that claimed the session.
 * @property {string=} agentId Stable subagent or runner identity.
 * @property {string=} taskId Task or Playwright script identity.
 * @property {string} claimedAt ISO timestamp when the lease was created.
 * @property {string} heartbeatAt ISO timestamp of the last claim/heartbeat.
 * @property {string} expiresAt ISO timestamp after which the lease may be reclaimed.
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
  const remoteBrokers = options.remoteBrokerManager ?? createRemoteBrokerManager();
  const proxyManagerUrl = normalizeHttpUrl(options.proxyManagerUrl ?? DEFAULT_PROXY_MANAGER_URL, 'proxyManagerUrl');
  const appRegistryFile = path.resolve(options.appRegistryFile ?? path.join(worktree, '.pw-dev', 'apps.json'));
  const apps = createAppRegistry(loadPersistedApps(appRegistryFile), {
    persist: (registeredApps) => persistApps(appRegistryFile, registeredApps),
  });
  const browserConfigRegistryFile = path.resolve(options.browserConfigRegistryFile ?? path.join(worktree, '.pw-dev', 'browser-configs.json'));
  const browserConfigs = createBrowserConfigRegistry(loadPersistedBrowserConfigs(browserConfigRegistryFile), {
    persist: (registeredBrowserConfigs) => persistRegistryFile(browserConfigRegistryFile, { version: 1, browserConfigs: registeredBrowserConfigs }),
  });
  const proxyRegistryFile = path.resolve(options.proxyRegistryFile ?? path.join(worktree, '.pw-dev', 'proxies.json'));
  const proxies = createProxyRegistry(loadPersistedProxies(proxyRegistryFile), {
    persist: (registeredProxies) => persistProxies(proxyRegistryFile, registeredProxies),
  });
  const sessions = createSessionRegistry();
  const browserRegistryFile = path.resolve(options.browserRegistryFile ?? path.join(worktree, '.pw-dev', 'browsers.json'));
  const browsers = createBrowserRegistry(loadPersistedBrowsers(browserRegistryFile), {
    persist: (registeredBrowsers) => persistBrowsers(browserRegistryFile, registeredBrowsers),
  });
  let origin;

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url?.startsWith('/_pwdev/')) {
        await handlePwDevRequest({ req, res, root, worktree, origin, startedAt, metadata, apps, browserConfigs, proxies, browsers, sessions, broker, remoteBrokers, proxyManagerUrl, ensureProxyManager: options.ensureProxyManager });
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
    proxyBrokerUpgrade({ req, socket, head, broker, sessions });
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
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await remoteBrokers.close();
    },
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
 * - `GET|PATCH|DELETE /_pwdev/apps/:id`
 * - `GET /_pwdev/apps/:id/manifest`
 * - `GET|POST /_pwdev/browser-configs`
 * - `GET|DELETE /_pwdev/browser-configs/:id`
 * - `GET|POST /_pwdev/browsers`
 * - `GET|DELETE /_pwdev/browsers/:id`
 * - `POST /_pwdev/browsers/:id/start`
 * - `POST /_pwdev/browsers/:id/stop`
 * - `GET /_pwdev/sessions`
 * - `GET /_pwdev/sessions/:id`
 * - `POST /_pwdev/sessions/:id/stop`
 * - `POST /_pwdev/sessions/:id/claim`
 * - `POST /_pwdev/sessions/:id/heartbeat`
 * - `POST /_pwdev/sessions/:id/release`
 * - `GET|POST /_pwdev/proxies`
 * - `GET|DELETE /_pwdev/proxies/:id`
 * - `GET /_pwdev/proxies/:id/traffic`
 * - `GET|POST /_pwdev/remote-brokers`
 * - `DELETE /_pwdev/remote-brokers/:id`
 * - `POST /_pwdev/remote-brokers/:id/disconnect`
 * - `POST /_pwdev/remote-brokers/:id/stop`
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
 *   browsers: PwDevBrowserRegistry,
 *   sessions: PwDevSessionRegistry,
 *   broker: PwDevBrokerPairing,
 *   remoteBrokers: { list: () => unknown[], provision: (request: Record<string, unknown>) => Promise<unknown>, remove: (id: string) => Promise<boolean>, stop: (id: string) => Promise<boolean> },
 *   proxyManagerUrl: string,
 *   ensureProxyManager?: () => Promise<unknown>,
 * }} options
 * @returns {Promise<void>}
 */
export async function handlePwDevRequest({ req, res, root, worktree, origin, startedAt, metadata, apps, browserConfigs, proxies, browsers, sessions, broker, remoteBrokers, proxyManagerUrl, ensureProxyManager }) {
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
    await proxyBrokerHttpRequest({ req, res, requestUrl, broker, sessions, serverUrl });
    return;
  }

  if (requestUrl.pathname.startsWith('/_pwdev/proxy')) {
    if (ensureProxyManager) await ensureProxyManager();
    await proxyProxyManagerHttpRequest({ req, res, requestUrl, proxyManagerUrl });
    return;
  }

  if (requestUrl.pathname === '/_pwdev/remote-brokers' || requestUrl.pathname.startsWith('/_pwdev/remote-brokers/')) {
    await handleRemoteBrokersRequest({ req, res, requestUrl, remoteBrokers, writeBody });
    return;
  }

  if (requestUrl.pathname === '/_pwdev/browser-configs' || requestUrl.pathname.startsWith('/_pwdev/browser-configs/')) {
    await handleBrowserConfigsRequest({ req, res, requestUrl, browserConfigs, browsers, sessions, writeBody });
    return;
  }

  if (requestUrl.pathname === '/_pwdev/browsers' || requestUrl.pathname.startsWith('/_pwdev/browsers/')) {
    await handleBrowsersRequest({ req, res, requestUrl, apps, browserConfigs, proxies, browsers, sessions, broker, proxyManagerUrl, ensureProxyManager, serverUrl, writeBody });
    return;
  }

  if (requestUrl.pathname.startsWith('/_pwdev/apps')) {
    await handleAppsRequest({ req, res, requestUrl, apps, proxies, sessions, broker, serverUrl, writeBody });
    return;
  }

  if (requestUrl.pathname.startsWith('/_pwdev/sessions')) {
    await handleSessionsRequest({ req, res, requestUrl, apps, browsers, proxies, sessions, broker, proxyManagerUrl, ensureProxyManager, serverUrl, writeBody });
    return;
  }

  if (requestUrl.pathname.startsWith('/_pwdev/proxies')) {
    await handleProxiesRequest({ req, res, requestUrl, apps, browsers, sessions, broker, proxies, proxyManagerUrl, writeBody });
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
      remoteBrokers: remoteBrokers.list(),
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

function createBrowserConfigRegistry(initialBrowserConfigs = [], options = {}) {
  const browserConfigs = new Map(initialBrowserConfigs.map((browserConfig) => [browserConfig.id, browserConfig]));
  const persist = () => options.persist?.(Array.from(browserConfigs.values()));
  return {
    list: () => Array.from(browserConfigs.values()).sort((a, b) => a.id.localeCompare(b.id)).map((browserConfig) => ({ ...browserConfig })),
    get: (id) => browserConfigs.has(id) ? { ...browserConfigs.get(id) } : undefined,
    upsert(raw) {
      const browserConfig = validateBrowserConfig(raw);
      const existing = browserConfigs.get(browserConfig.id);
      const saved = { ...existing, ...browserConfig, updatedAt: new Date().toISOString() };
      if (!existing?.createdAt) saved.createdAt = saved.updatedAt;
      browserConfigs.set(saved.id, saved);
      persist();
      return { ...saved };
    },
    delete(id) {
      const deleted = browserConfigs.delete(id);
      if (deleted) persist();
      return deleted;
    },
  };
}

/**
 * Durable reusable browser registry. A browser references existing
 * assets; only its selected proxy reservation and derived profile are stored.
 * @param {Record<string, unknown>[]=} initialBrowsers
 * @param {{ persist?: (browsers: Record<string, unknown>[]) => void }} options
 * @returns {PwDevBrowserRegistry}
 */
export function createBrowserRegistry(initialBrowsers = [], options = {}) {
  const browsers = new Map();
  const persist = () => options.persist?.(Array.from(browsers.values()).map((item) => ({ ...item })));
  const registry = {
    list: () => Array.from(browsers.values()).sort((a, b) => a.id.localeCompare(b.id)).map((item) => ({ ...item })),
    get: (id) => browsers.has(id) ? { ...browsers.get(id) } : undefined,
    upsert(raw) {
      const browser = validateBrowserRegistration(raw);
      const existing = browsers.get(browser.id);
      const saved = { ...existing, ...browser, updatedAt: new Date().toISOString() };
      if (!existing?.createdAt) saved.createdAt = saved.updatedAt;
      browsers.set(saved.id, saved);
      persist();
      return { ...saved };
    },
    update(id, patch) {
      const existing = browsers.get(id);
      if (!existing) return undefined;
      const saved = validateBrowserRegistration({ ...existing, ...patch, id });
      saved.createdAt = existing.createdAt;
      saved.updatedAt = new Date().toISOString();
      browsers.set(id, saved);
      persist();
      return { ...saved };
    },
    delete(id) {
      const deleted = browsers.delete(id);
      if (deleted) persist();
      return deleted;
    },
  };
  for (const item of initialBrowsers) registry.upsert(item);
  return registry;
}

function loadPersistedBrowsers(file) {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.browsers)) throw new Error('expected an object with a browsers array');
    return parsed.browsers.map(validateBrowserRegistration);
  } catch (error) {
    throw new Error(`Could not load browser registry ${file}: ${error.message}`);
  }
}

function persistBrowsers(file, browsers) {
  persistRegistryFile(file, {
    version: 1,
    browsers: browsers.map(({ sessionId: _sessionId, ...browser }) => browser),
  });
}

function loadPersistedBrowserConfigs(file) {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.browserConfigs)) throw new Error('expected an object with a browserConfigs array');
    return parsed.browserConfigs.map(validateBrowserConfig);
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
  const { pid: _pid, running: _running, ...persistent } = proxy;
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
      ...(session.proxyLease ? { proxyLease: { ...session.proxyLease } } : {}),
      ...(session.lease ? { lease: { ...session.lease } } : {}),
    },
  ]));
}

function cloneSession(session) {
  return {
    ...session,
    ...(session.activeTask ? { activeTask: { ...session.activeTask } } : {}),
    ...(session.proxyLease ? { proxyLease: { ...session.proxyLease } } : {}),
    ...(session.lease ? { lease: { ...session.lease } } : {}),
  };
}

/**
 * Remove expired agent leases while preserving their broker-owned sessions.
 * This is reconciliation-on-read so a crashed agent does not leave an
 * in-memory lock behind and the server does not need a timer per session.
 *
 * @param {PwDevSessionRegistry} sessions
 * @param {number=} now
 */
function reconcileSessionLeases(sessions, now = Date.now()) {
  for (const session of sessions.list()) {
    if (session.lease && isSessionLeaseExpired(session.lease, now)) {
      sessions.update(session.sessionId, { lease: undefined });
    }
  }
}

function isSessionLeaseExpired(lease, now = Date.now()) {
  const expiresAt = Date.parse(lease?.expiresAt ?? '');
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function sessionLeaseInput(rawLease, { requireOwner = true } = {}) {
  if (rawLease === undefined || rawLease === null) return undefined;
  if (!rawLease || typeof rawLease !== 'object' || Array.isArray(rawLease)) {
    throwValidationError('lease must be an object');
  }
  const owner = optionalString(rawLease.owner, 'lease.owner');
  if (requireOwner && !owner) throwValidationError('lease.owner must be a non-empty string');
  const ttlMs = rawLease.ttlMs === undefined
    ? DEFAULT_SESSION_LEASE_TTL_MS
    : requiredPositiveInteger(rawLease.ttlMs, 'lease.ttlMs');
  if (ttlMs > MAX_SESSION_LEASE_TTL_MS) {
    throwValidationError(`lease.ttlMs must be at most ${MAX_SESSION_LEASE_TTL_MS}`);
  }
  return omitUndefined({
    owner,
    agentId: optionalString(rawLease.agentId, 'lease.agentId'),
    taskId: optionalString(rawLease.taskId, 'lease.taskId'),
    ttlMs,
  });
}

function createSessionLease(input, now = new Date()) {
  const claimedAt = now.toISOString();
  return {
    leaseId: `lease_${randomUUID()}`,
    owner: input.owner,
    agentId: input.agentId,
    taskId: input.taskId,
    claimedAt,
    heartbeatAt: claimedAt,
    expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
  };
}

function refreshSessionLease(session, input, now = new Date()) {
  const lease = session.lease;
  if (!lease || lease.leaseId !== input.leaseId) {
    const error = new Error('Session lease is missing or does not belong to this client');
    error.statusCode = 409;
    throw error;
  }
  if (isSessionLeaseExpired(lease, now.getTime())) {
    const error = new Error('Session lease has expired');
    error.statusCode = 409;
    throw error;
  }
  const heartbeatAt = now.toISOString();
  return {
    ...lease,
    heartbeatAt,
    expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
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
    listByBrowser(browserConfigId) {
      return Array.from(sessions.values())
        .filter((session) => session.browserConfigId === browserConfigId)
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
  const managedProfiles = Array.isArray(status.proxies)
    ? status.proxies
        .filter((proxy) => proxy && typeof proxy === 'object' && typeof proxy.id === 'string' && proxy.id.trim() !== '')
        .map(managedProxyRegistration)
    : [];
  const profileIds = new Set(managedProfiles.map((proxy) => proxy.id));

  for (const proxy of managedProfiles) {
    proxies.upsert(proxy);
    if (proxy.appId) {
      const app = apps.get(proxy.appId);
      if (app && app.proxyId !== proxy.id) {
        apps.update(proxy.appId, { proxyId: proxy.id });
      }
    }
  }

  const staleIds = proxies.list()
    .filter((proxy) => proxy.managed && !profileIds.has(proxy.id))
    .map((proxy) => proxy.id);
  if (!staleIds.length) return;

  for (const id of staleIds) proxies.delete(id);
  for (const app of apps.list()) {
    if (app.proxyId && staleIds.includes(app.proxyId)) {
      apps.update(app.id, { proxyId: undefined });
    }
  }
}

function managedProxyRegistration(proxy) {
  return omitUndefined({
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
    running: proxy.running,
    rulesetFile: proxy.rulesetFile,
    rules: proxy.rules,
    managed: true,
    createdAt: proxy.createdAt ?? proxy.startedAt,
    updatedAt: proxy.updatedAt,
  });
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
 *   browsers: PwDevBrowserRegistry,
 *   sessions: PwDevSessionRegistry,
 *   broker: PwDevBrokerPairing,
 *   proxyManagerUrl: string,
 *   writeBody: boolean,
 * }} options
 * @returns {Promise<void>}
 */
async function handleProxiesRequest({ req, res, requestUrl, apps, browsers, sessions, broker, proxies, proxyManagerUrl, writeBody }) {
  const pathParts = requestUrl.pathname.split('/').filter(Boolean);

  if (pathParts.length === 2 && pathParts[0] === '_pwdev' && pathParts[1] === 'proxies') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      await reconcileManagedProxies({ apps, proxies, proxyManagerUrl });
      writeJson(res, 200, { ok: true, proxies: proxies.list() }, writeBody);
      return;
    }

    if (req.method === 'POST') {
      const payload = await readJsonBody(req);
      await reconcileManagedProxies({ apps, proxies, proxyManagerUrl });
      const existing = proxies.get(payload.id);
      const references = existing ? proxyReferences(existing.id, { apps, browsers }) : [];
      if (existing && references.length && !isManagedProxyLifecycleRefresh(existing, payload)) {
        const error = new Error(`Proxy is referenced by ${references.join(', ')}`);
        error.statusCode = 409;
        throw error;
      }
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
    await reconcileManagedProxies({ apps, proxies, proxyManagerUrl });
    await reconcileSessionsBestEffort({ sessions, broker });
    const references = proxyReferences(id, { apps, browsers });
    const occupants = proxyOccupants(id, sessions);
    if (occupants.length) {
      const error = new Error(`Proxy is occupied by ${occupants.join(', ')}`);
      error.statusCode = 409;
      throw error;
    }
    if (references.length) {
      const error = new Error(`Proxy is referenced by ${references.join(', ')}`);
      error.statusCode = 409;
      throw error;
    }
    const deleted = proxies.delete(id);
    writeJson(res, deleted ? 200 : 404, deleted
      ? { ok: true, id }
      : { ok: false, error: `Unknown proxy: ${id}` });
    return;
  }

  res.writeHead(405, { allow: 'GET, HEAD, DELETE' });
  res.end('Method Not Allowed');
}

function proxyReferences(proxyId, { apps, browsers }) {
  return [
    ...apps.list()
      .filter((app) => app.proxyId === proxyId)
      .map((app) => `app:${app.id}`),
    ...browsers.list()
      .filter((browser) => browser.proxyId === proxyId || browser.proxyIds?.includes(proxyId))
      .map((browser) => `browser:${browser.id}`),
  ];
}

function isManagedProxyLifecycleRefresh(existing, candidate) {
  if (!existing.managed || candidate?.managed !== true) return false;
  return [
    'kind',
    'proxyUrl',
    'guiUrl',
    'storageDir',
    'proxyPort',
    'uiPort',
    'brokerProxyForwardId',
  ].every((field) => existing[field] === candidate[field]);
}

function proxyOccupants(proxyId, sessions) {
  return sessions.list()
    .filter((session) => session.proxyId === proxyId)
    .map((session) => session.sessionId);
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
 *   browsers: PwDevBrowserRegistry,
 *   proxies: PwDevProxyRegistry,
 *   sessions: PwDevSessionRegistry,
 *   broker: PwDevBrokerPairing,
 *   proxyManagerUrl: string,
 *   ensureProxyManager?: () => Promise<unknown>,
 *   serverUrl: string,
 *   writeBody: boolean,
 * }} options
 * @returns {Promise<void>}
 */
async function handleSessionsRequest({ req, res, requestUrl, apps, browsers, proxies, sessions, broker, proxyManagerUrl, ensureProxyManager, serverUrl, writeBody }) {
  const pathParts = requestUrl.pathname.split('/').filter(Boolean);

  if (pathParts.length === 2 && pathParts[0] === '_pwdev' && pathParts[1] === 'sessions') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end('Method Not Allowed');
      return;
    }
    await reconcileSessionsBestEffort({ sessions, broker });
    reconcileSessionLeases(sessions);
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
    reconcileSessionLeases(sessions);
    const session = sessions.get(sessionId);
    if (!session) {
      writeJson(res, 404, { ok: false, error: `Unknown session: ${sessionId}` }, writeBody);
      return;
    }
    const app = apps.get(session.appId);
    writeJson(res, 200, { ok: true, session, app: app ? buildAppResponse(app, sessions) : undefined, serverUrl }, writeBody);
    return;
  }

  if (pathParts.length === 4 && ['claim', 'heartbeat', 'release'].includes(pathParts[3])) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      res.end('Method Not Allowed');
      return;
    }
    await reconcileSessionsBestEffort({ sessions, broker });
    reconcileSessionLeases(sessions);
    const session = sessions.get(sessionId);
    if (!session) {
      writeJson(res, 404, { ok: false, error: `Unknown session: ${sessionId}` }, writeBody);
      return;
    }
    const payload = await readJsonBody(req);
    const action = pathParts[3];
    if (action === 'claim') {
      const input = sessionLeaseInput(payload);
      const current = session.lease;
      if (current && current.owner !== input.owner) {
        const error = new Error(`Session is leased by ${current.owner}`);
        error.statusCode = 409;
        writeJson(res, error.statusCode, { ok: false, error: error.message, session: current }, writeBody);
        return;
      }
      const lease = createSessionLease(input);
      if (current?.owner === input.owner) lease.leaseId = current.leaseId;
      const updated = sessions.update(sessionId, { lease });
      writeJson(res, 200, { ok: true, session: updated, lease }, writeBody);
      return;
    }
    if (action === 'heartbeat') {
      const leaseId = requiredString(payload.leaseId, 'leaseId');
      const input = sessionLeaseInput(payload, { requireOwner: false });
      const lease = refreshSessionLease(session, { leaseId, ttlMs: input?.ttlMs ?? DEFAULT_SESSION_LEASE_TTL_MS });
      const updated = sessions.update(sessionId, { lease });
      writeJson(res, 200, { ok: true, session: updated, lease }, writeBody);
      return;
    }
    const leaseId = requiredString(payload.leaseId, 'leaseId');
    if (!session.lease || session.lease.leaseId !== leaseId) {
      const error = new Error('Session lease is missing or does not belong to this client');
      error.statusCode = 409;
      writeJson(res, error.statusCode, { ok: false, error: error.message, session }, writeBody);
      return;
    }
    const updated = sessions.update(sessionId, { lease: undefined });
    writeJson(res, 200, { ok: true, session: updated, released: true }, writeBody);
    return;
  }

  if (pathParts.length === 4 && pathParts[3] === 'stop') {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      res.end('Method Not Allowed');
      return;
    }
    await reconcileSessionsBestEffort({ sessions, broker });
    reconcileSessionLeases(sessions);
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
    if (session.browserId) browsers.update(session.browserId, { sessionId: undefined });
    const proxyStop = await stopManagedProxyIfIdle({
      proxyId: session.proxyId,
      proxies,
      sessions,
      proxyManagerUrl,
      ensureProxyManager,
    });
    const app = apps.get(session.appId);
    writeJson(res, 200, {
      ok: true,
      session,
      releasedProxyLease: session.proxyLease,
      app: app ? buildAppResponse(app, sessions) : undefined,
      stop,
      proxyStop,
    }, writeBody);
    return;
  }

  writeJson(res, 404, { ok: false, error: 'Unknown pw-dev sessions endpoint' }, writeBody);
}

async function ensureManagedProxyRunning({ proxyId, proxies, proxyManagerUrl, ensureProxyManager }) {
  if (!proxyId) return;
  const registered = proxies.get(proxyId);
  if (!registered?.managed) return;
  if (ensureProxyManager) await ensureProxyManager();
  const started = await brokerJson(proxyManagerUrl, `/_proxy/proxies/${encodeURIComponent(proxyId)}/start`, {
    method: 'POST',
  });
  if (started.proxy) proxies.upsert(managedProxyRegistration(started.proxy));
}

async function stopManagedProxyIfIdle({ proxyId, proxies, sessions, proxyManagerUrl, ensureProxyManager }) {
  if (!proxyId || sessions.list().some((session) => session.proxyId === proxyId)) return undefined;
  const registered = proxies.get(proxyId);
  if (!registered?.managed || registered.running === false) return undefined;
  if (ensureProxyManager) await ensureProxyManager();
  const stopped = await brokerJson(proxyManagerUrl, `/_proxy/proxies/${encodeURIComponent(proxyId)}/stop`, {
    method: 'POST',
  });
  if (stopped.proxy) proxies.upsert(managedProxyRegistration(stopped.proxy));
  return stopped;
}

function browserProfile(browserConfig, browser) {
  const base = browserConfig.profile ?? browserConfig.id;
  const profile = browser.profile ?? `${base}__${browser.id}`;
  validateBrowserProfileName(profile, 'profile');
  return profile;
}

function reservedBrowserProxy(browsers, proxyId, exceptId) {
  return browsers.list().find((item) => item.id !== exceptId && item.proxyId === proxyId);
}

function chooseBrowserProxy({ browser, browsers, proxies }) {
  if (browser.proxyId) {
    if (!proxies.get(browser.proxyId)) throw new Error(`Unknown proxy: ${browser.proxyId}`);
    const owner = reservedBrowserProxy(browsers, browser.proxyId, browser.id);
    if (owner) {
      const error = new Error(`Proxy is reserved by browser: ${owner.id}`);
      error.statusCode = 409;
      throw error;
    }
    return browser.proxyId;
  }
  for (const proxyId of browser.proxyIds ?? []) {
    if (!proxies.get(proxyId)) continue;
    if (!reservedBrowserProxy(browsers, proxyId, browser.id)) return proxyId;
  }
  if (browser.proxyIds?.length) {
    const error = new Error(`No proxy is available for browser: ${browser.id}`);
    error.statusCode = 409;
    throw error;
  }
  return undefined;
}

function buildBrowserResponse({ browser, apps, browserConfigs, proxies, sessions }) {
  const app = browser.appId ? apps.get(browser.appId) : undefined;
  const browserConfig = browserConfigs.get(browser.browserConfigId);
  const session = browser.sessionId ? sessions.get(browser.sessionId) : undefined;
  const proxy = browser.proxyId ? proxies.get(browser.proxyId) : undefined;
  return omitUndefined({
    ...browser,
    sessionId: session?.sessionId,
    status: session ? 'occupied' : 'ready',
    occupancy: session
      ? omitUndefined({
        state: session.lease ? 'claimed' : 'unclaimed',
        owner: session.lease?.owner,
        agentId: session.lease?.agentId,
        taskId: session.lease?.taskId,
        heartbeatAt: session.lease?.heartbeatAt,
        expiresAt: session.lease?.expiresAt,
      })
      : { state: 'ready' },
    components: {
      app: app ?? null,
      proxy: proxy ?? null,
      browserConfig: browserConfig ?? null,
      session: session ?? null,
    },
  });
}

async function handleBrowsersRequest({ req, res, requestUrl, apps, browserConfigs, proxies, browsers, sessions, broker, proxyManagerUrl, ensureProxyManager, serverUrl, writeBody }) {
  // Managed proxies may have been created through the delegated proxy API.
  // Reconcile before validating browser references so the public browser API
  // sees those durable profiles without requiring a separate registry POST.
  await reconcileManagedProxies({ apps, proxies, proxyManagerUrl });
  const parts = requestUrl.pathname.split('/').filter(Boolean);
  if (parts.length === 2) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      await reconcileSessionsBestEffort({ sessions, broker });
      reconcileSessionLeases(sessions);
      writeJson(res, 200, { ok: true, browsers: browsers.list().map((browser) => buildBrowserResponse({ browser, apps, browserConfigs, proxies, sessions })) }, writeBody);
      return;
    }
    if (req.method === 'POST') {
      const raw = await readJsonBody(req);
      if (raw.proxyId !== undefined && raw.proxyIds !== undefined) {
        throwValidationError('proxyId and proxyIds are mutually exclusive');
      }
      const candidate = validateBrowserRegistration(raw);
      const browser = candidate;
      if (!browserConfigs.get(browser.browserConfigId)) throw new Error(`Unknown browser config: ${browser.browserConfigId}`);
      if (browser.appId && !apps.get(browser.appId)) throw new Error(`Unknown app: ${browser.appId}`);
      for (const proxyId of browser.proxyIds ?? (browser.proxyId ? [browser.proxyId] : [])) {
        if (!proxies.get(proxyId)) throw new Error(`Unknown proxy: ${proxyId}`);
      }
      if (browser.proxyId) {
        const owner = reservedBrowserProxy(browsers, browser.proxyId, browser.id);
        if (owner) {
          const error = new Error(`Proxy is reserved by browser: ${owner.id}`);
          error.statusCode = 409;
          throw error;
        }
      }
      const saved = browsers.upsert(browser);
      writeJson(res, 200, { ok: true, browser: buildBrowserResponse({ browser: saved, apps, browserConfigs, proxies, sessions }) }, writeBody);
      return;
    }
  }

  const id = parts[2] ? decodeURIComponent(parts[2]) : undefined;
  const browser = id ? browsers.get(id) : undefined;
  if (!id || !browser) {
    writeJson(res, 404, { ok: false, error: `Unknown browser: ${id}` }, writeBody);
    return;
  }
  if (parts.length === 3 && (req.method === 'GET' || req.method === 'HEAD')) {
    await reconcileSessionsBestEffort({ sessions, broker });
    reconcileSessionLeases(sessions);
    writeJson(res, 200, { ok: true, browser: buildBrowserResponse({ browser, apps, browserConfigs, proxies, sessions }) }, writeBody);
    return;
  }
  if (parts.length === 3 && req.method === 'DELETE') {
    reconcileSessionLeases(sessions);
    const activeSession = browser.sessionId ? sessions.get(browser.sessionId) : undefined;
    if (activeSession?.lease) {
      const error = new Error(`Browser is occupied by agent ${activeSession.lease.owner}`);
      error.statusCode = 409;
      throw error;
    }
    const browserSession = browser.sessionId ? sessions.get(browser.sessionId) : undefined;
    if (browserSession) {
      const session = browserSession;
      await brokerJson(session.brokerUrl, '/_broker/stop', { method: 'POST', body: { instanceId: session.browserInstanceId } });
      sessions.delete(browser.sessionId);
    }
    const browserConfig = browserConfigs.get(browser.browserConfigId);
    if (browserConfig) {
      const profile = browserProfile(browserConfig, browser);
      const app = browser.appId ? apps.get(browser.appId) : undefined;
      await brokerJson(broker.resolve(browserConfig.brokerUrl ?? app?.brokerUrl), '/_broker/profiles/clear', {
        method: 'POST',
        body: { profile },
      });
    }
    browsers.delete(id);
    const proxyStop = await stopManagedProxyIfIdle({
      proxyId: browserSession?.proxyId ?? browser.proxyId,
      proxies,
      sessions,
      proxyManagerUrl,
      ensureProxyManager,
    });
    writeJson(res, 200, { ok: true, id, destroyed: true, proxyStop }, writeBody);
    return;
  }
  const action = parts[3];
  if (parts.length === 4 && action === 'start' && req.method === 'POST') {
    if (!browserConfigs.get(browser.browserConfigId)) throw new Error(`Unknown browser config: ${browser.browserConfigId}`);
    if (browser.sessionId && sessions.get(browser.sessionId)) {
      const error = new Error('Browser already has an active session');
      error.statusCode = 409;
      throw error;
    }
    const startPayload = await readJsonBody(req);
    const requestedLease = sessionLeaseInput(startPayload.lease);
    const browserConfig = browserConfigs.get(browser.browserConfigId);
    const app = browser.appId ? apps.get(browser.appId) : undefined;
    if (browser.appId && !app) throw new Error(`Unknown app: ${browser.appId}`);
    const selectedProxyId = chooseBrowserProxy({ browser, browsers, proxies });
    const profile = browserProfile(browserConfig, browser);
    const sessionId = `${browser.id}__default`;
    const brokerUrl = broker.resolve(browserConfig.brokerUrl ?? app?.brokerUrl);
    await ensureManagedProxyRunning({ proxyId: selectedProxyId, proxies, proxyManagerUrl, ensureProxyManager });
    const proxy = resolveProxyForBrowserStart({ proxies, proxyId: selectedProxyId });
    const brokerStatus = proxy.proxyId && proxy.proxyServer
      ? await brokerJson(brokerUrl, '/_broker/status')
      : undefined;
    const proxyPeer = brokerStatus?.topology?.mode === 'ssh' && brokerStatus.topology.remote
      ? 'ssh-peer'
      : undefined;
    const start = await brokerJson(brokerUrl, '/_broker/start', {
      method: 'POST',
      body: omitUndefined({
        profile,
        proxyServer: proxy.proxyServer,
        proxyForwardId: proxy.proxyForwardId,
        proxyPeer,
        proxyName: proxyPeer ? proxy.proxyId : undefined,
        ignoreSslErrors: browserConfig.ignoreSslErrors,
        proxyBypassList: browserConfig.proxyBypassList,
        headless: browserConfig.headless,
        resetProfile: browserConfig.resetProfile,
      }),
    });
    const session = sessions.upsert(omitUndefined({
      sessionId,
      appId: app?.id,
      browserId: browser.id,
      browserConfigId: browserConfig.id,
      scope: 'default',
      profile,
      cdpUrl: rewriteBrokerUrlToServerProxy(start.cdpUrl, serverUrl),
      brokerUrl,
      browserInstanceId: start.instanceId,
      browserStartedAt: start.startedAt,
      proxyId: selectedProxyId,
      proxyLease: selectedProxyId ? { proxyId: selectedProxyId, sessionId, leasedAt: new Date().toISOString(), trafficStartTime: String(Date.now()) } : undefined,
      proxyForwardId: start.proxyForwardId,
      proxyServer: start.proxyServer,
      lease: requestedLease ? createSessionLease(requestedLease) : undefined,
    }));
    const updated = browsers.update(id, { proxyId: selectedProxyId ?? browser.proxyId, profile, sessionId });
    writeJson(res, 200, { ok: true, browser: buildBrowserResponse({ browser: updated, apps, browserConfigs, proxies, sessions }), session, start: { ...start, cdpUrl: session.cdpUrl } }, writeBody);
    return;
  }
  if (parts.length === 4 && action === 'stop' && req.method === 'POST') {
    const session = browser.sessionId ? sessions.get(browser.sessionId) : undefined;
    if (session) {
      const stop = await brokerJson(session.brokerUrl, '/_broker/stop', { method: 'POST', body: { instanceId: session.browserInstanceId } });
      sessions.delete(session.sessionId);
      const updated = browsers.update(id, { sessionId: undefined });
      const proxyStop = await stopManagedProxyIfIdle({
        proxyId: session.proxyId,
        proxies,
        sessions,
        proxyManagerUrl,
        ensureProxyManager,
      });
      writeJson(res, 200, { ok: true, browser: buildBrowserResponse({ browser: updated, apps, browserConfigs, proxies, sessions }), releasedSession: session.sessionId, stop, proxyStop }, writeBody);
      return;
    }
    const proxyStop = await stopManagedProxyIfIdle({
      proxyId: browser.proxyId,
      proxies,
      sessions,
      proxyManagerUrl,
      ensureProxyManager,
    });
    writeJson(res, 200, { ok: true, browser: buildBrowserResponse({ browser, apps, browserConfigs, proxies, sessions }), alreadyStopped: true, proxyStop }, writeBody);
    return;
  }
  writeJson(res, 404, { ok: false, error: 'Unknown browser endpoint' }, writeBody);
}

async function handleBrowserConfigsRequest({ req, res, requestUrl, browserConfigs, browsers, sessions, writeBody }) {
  const parts = requestUrl.pathname.split('/').filter(Boolean);
  if (parts.length === 2) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      writeJson(res, 200, { ok: true, browserConfigs: browserConfigs.list() }, writeBody);
      return;
    }
    if (req.method === 'POST') {
      const payload = await readJsonBody(req);
      const existing = browserConfigs.get(payload.id);
      const references = existing ? browserConfigReferences(existing.id, browsers) : [];
      if (existing && references.length) {
        const error = new Error(`Browser config is referenced by ${references.join(', ')}`);
        error.statusCode = 409;
        throw error;
      }
      const browserConfig = browserConfigs.upsert(payload);
      writeJson(res, 200, { ok: true, browserConfig }, writeBody);
      return;
    }
  }
  const id = parts[2] ? decodeURIComponent(parts[2]) : undefined;
  const browserConfig = id ? browserConfigs.get(id) : undefined;
  if (!id || !browserConfig) {
    writeJson(res, 404, { ok: false, error: `Unknown browser config: ${id}` }, writeBody);
    return;
  }
  if (parts.length === 3 && (req.method === 'GET' || req.method === 'HEAD')) {
    writeJson(res, 200, { ok: true, browserConfig }, writeBody);
    return;
  }
  if (parts.length === 3 && req.method === 'DELETE') {
    const occupants = browserConfigOccupants(id, sessions);
    if (occupants.length) {
      const error = new Error(`Browser config is occupied by ${occupants.join(', ')}`);
      error.statusCode = 409;
      throw error;
    }
    const references = browserConfigReferences(id, browsers);
    if (references.length) {
      const error = new Error(`Browser config is referenced by ${references.join(', ')}`);
      error.statusCode = 409;
      throw error;
    }
    browserConfigs.delete(id);
    writeJson(res, 200, { ok: true, id }, writeBody);
    return;
  }
  writeJson(res, 404, { ok: false, error: 'Unknown browser config endpoint' }, writeBody);
}

function browserConfigReferences(browserConfigId, browsers) {
  return browsers.list()
    .filter((browser) => browser.browserConfigId === browserConfigId)
    .map((browser) => `browser:${browser.id}`);
}

function browserConfigOccupants(browserConfigId, sessions) {
  return sessions.list()
    .filter((session) => session.browserConfigId === browserConfigId)
    .map((session) => session.sessionId);
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
      error: 'App-scoped browser lifecycle is retired. Create and start a persisted browser config under /_pwdev/browser-configs.',
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
 *   sessions: PwDevSessionRegistry,
 *   serverUrl: string,
 * }} options
 * @returns {Promise<void>}
 */
async function proxyBrokerHttpRequest({ req, res, requestUrl, broker, sessions, serverUrl, brokerPath }) {
  const brokerUrl = resolveBrokerForCdpRequest({ requestUrl, broker, sessions });
  const upstreamUrl = new URL(brokerPath ?? proxyBrokerPath(requestUrl), ensureTrailingSlash(brokerUrl));
  const headers = { ...req.headers, host: upstreamUrl.host };

  const upstream = http.request(upstreamUrl, {
    method: req.method,
    headers,
  }, (response) => {
    if (!isCdpDiscoveryPath(requestUrl)) {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
      return;
    }
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(response.statusCode ?? 502, response.headers);
        res.end(body);
        return;
      }
      const rewritten = rewriteCdpDebuggerUrls(payload, serverUrl);
      const output = Buffer.from(JSON.stringify(rewritten));
      const headers = { ...response.headers, 'content-length': output.length };
      delete headers['transfer-encoding'];
      res.writeHead(response.statusCode ?? 502, headers);
      res.end(output);
    });
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
 *   sessions: PwDevSessionRegistry,
 * }} options
 */
function proxyBrokerUpgrade({ req, socket, head, broker, sessions }) {
  let brokerUrl;
  let upstreamUrl;
  try {
    const requestUrl = new URL(req.url || '/', 'http://local');
    brokerUrl = resolveBrokerForCdpRequest({ requestUrl, broker, sessions });
    upstreamUrl = new URL(proxyBrokerPath(requestUrl), ensureTrailingSlash(brokerUrl));
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

function resolveBrokerForCdpRequest({ requestUrl, broker, sessions }) {
  const match = /^\/_pwdev\/broker\/instances\/([^/]+)/.exec(requestUrl.pathname);
  if (match) {
    let instanceId;
    try {
      instanceId = decodeURIComponent(match[1]);
    } catch {
      instanceId = undefined;
    }
    if (instanceId) {
      const session = sessions?.list().find((candidate) => candidate.browserInstanceId === instanceId);
      if (session?.brokerUrl) return session.brokerUrl;
    }
  }
  return broker.resolve();
}

function isCdpDiscoveryPath(requestUrl) {
  return /^\/_pwdev\/broker\/instances\/[^/]+\/json\/(version|list)$/.test(requestUrl.pathname);
}

function rewriteCdpDebuggerUrls(value, serverUrl) {
  if (Array.isArray(value)) return value.map((item) => rewriteCdpDebuggerUrls(item, serverUrl));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = typeof child === 'string' && key.toLowerCase().endsWith('websocketdebuggerurl')
      ? rewriteWebSocketUrlToServerProxy(child, serverUrl)
      : rewriteCdpDebuggerUrls(child, serverUrl);
  }
  return output;
}

function rewriteWebSocketUrlToServerProxy(rawUrl, serverUrl) {
  try {
    const source = new URL(rawUrl);
    const target = new URL(serverUrl);
    source.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    source.host = target.host;
    if (source.pathname.startsWith('/_broker')) {
      source.pathname = `/_pwdev/broker${source.pathname.slice('/_broker'.length)}`;
    }
    return source.toString();
  } catch {
    return rawUrl;
  }
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
 * `instanceId` onto the app's default browser slot or an isolated named
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

function makeBrowserSession({ sessionId, browserId, appId, browserConfigId, scope, task, activeTask, brokerUrl, start, profile, cdpUrl, network, proxy, proxyLease }) {
  return omitUndefined({
    sessionId,
    browserId,
    appId,
    browserConfigId,
    scope,
    taskId: task?.id,
    profile: start.profile ?? profile,
    cdpUrl,
    brokerUrl,
    browserInstanceId: start.instanceId,
    browserStartedAt: start.startedAt,
    networkId: start.networkId ?? network.networkId,
    proxyId: proxy.proxyId,
    proxyLease,
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

/**
 * Provision remote loopback brokers and keep their local SSH forwards owned by
 * this pw-dev server process.
 *
 * @param {{
 *   req: http.IncomingMessage,
 *   res: http.ServerResponse,
 *   requestUrl: URL,
 *   remoteBrokers: { list: () => unknown[], provision: (request: Record<string, unknown>) => Promise<unknown>, remove: (id: string) => Promise<boolean>, stop: (id: string) => Promise<boolean> },
 *   writeBody: boolean,
 * }} options
 */
async function handleRemoteBrokersRequest({ req, res, requestUrl, remoteBrokers, writeBody }) {
  const basePath = '/_pwdev/remote-brokers';
  if (requestUrl.pathname === basePath) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      writeJson(res, 200, { ok: true, remoteBrokers: remoteBrokers.list() }, writeBody);
      return;
    }
    if (req.method === 'POST') {
      const remoteBroker = await remoteBrokers.provision(await readJsonBody(req));
      writeJson(res, 201, { ok: true, remoteBroker }, writeBody);
      return;
    }
    res.writeHead(405, { allow: 'GET, HEAD, POST' });
    res.end('Method Not Allowed');
    return;
  }

  const actionMatch = /^\/_pwdev\/remote-brokers\/([^/]+)\/(disconnect|stop)$/.exec(requestUrl.pathname);
  if (actionMatch) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      res.end('Method Not Allowed');
      return;
    }
    const id = decodeURIComponent(actionMatch[1]);
    const action = actionMatch[2];
    const completed = action === 'stop'
      ? await remoteBrokers.stop(id)
      : await remoteBrokers.remove(id);
    if (!completed) {
      const error = new Error(`Unknown remote broker: ${id}`);
      error.statusCode = 404;
      throw error;
    }
    writeJson(res, 200, { ok: true, id, [action === 'stop' ? 'stopped' : 'released']: true }, writeBody);
    return;
  }

  const match = /^\/_pwdev\/remote-brokers\/([^/]+)$/.exec(requestUrl.pathname);
  if (!match) {
    writeJson(res, 404, { ok: false, error: 'Unknown remote broker route' }, writeBody);
    return;
  }
  if (req.method !== 'DELETE') {
    res.writeHead(405, { allow: 'DELETE' });
    res.end('Method Not Allowed');
    return;
  }
  const id = decodeURIComponent(match[1]);
  if (!await remoteBrokers.remove(id)) {
    const error = new Error(`Unknown remote broker: ${id}`);
    error.statusCode = 404;
    throw error;
  }
  writeJson(res, 200, { ok: true, id, released: true }, writeBody);
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

function validateBrowserConfig(rawBrowser) {
  if (!rawBrowser || typeof rawBrowser !== 'object' || Array.isArray(rawBrowser)) {
    throwValidationError('browser config must be an object');
  }
  for (const field of ['appId', 'proxyId', 'proxyIds']) {
    if (Object.hasOwn(rawBrowser, field)) {
      throwValidationError(`${field} belongs to a browser, not a browser config`);
    }
  }
  const id = requiredString(rawBrowser.id, 'id');
  const profile = optionalString(rawBrowser.profile, 'profile');
  if (profile) validateBrowserProfileName(profile, 'profile');
  return omitUndefined({
    id,
    name: optionalString(rawBrowser.name, 'name'),
    targetUrl: optionalString(rawBrowser.targetUrl, 'targetUrl'),
    profile,
    brokerUrl: optionalString(rawBrowser.brokerUrl, 'brokerUrl'),
    proxyBypassList: optionalString(rawBrowser.proxyBypassList, 'proxyBypassList'),
    // pw-dev commonly runs browsers through an intercepting development proxy.
    // Make certificate-error tolerance the reusable browser-config default while
    // preserving an explicit false for strict TLS verification.
    ignoreSslErrors: rawBrowser.ignoreSslErrors === undefined ? true : Boolean(rawBrowser.ignoreSslErrors),
    headless: rawBrowser.headless === undefined ? undefined : Boolean(rawBrowser.headless),
    resetProfile: rawBrowser.resetProfile === undefined ? undefined : Boolean(rawBrowser.resetProfile),
  });
}

/**
 * Validate a durable browser definition.
 * @param {Record<string, unknown>} rawBrowser
 */
function validateBrowserRegistration(rawBrowser) {
  if (!rawBrowser || typeof rawBrowser !== 'object' || Array.isArray(rawBrowser)) {
    throwValidationError('browser must be an object');
  }
  const id = requiredString(rawBrowser.id, 'id');
  const proxyId = optionalString(rawBrowser.proxyId, 'proxyId');
  const proxyIds = rawBrowser.proxyIds === undefined ? undefined : validateStringArray(rawBrowser.proxyIds, 'proxyIds');
  if (proxyIds?.length === 0) throwValidationError('proxyIds must contain at least one proxy id');
  if (proxyIds && new Set(proxyIds).size !== proxyIds.length) throwValidationError('proxyIds must not contain duplicates');
  const profile = optionalString(rawBrowser.profile, 'profile');
  if (profile) validateBrowserProfileName(profile, 'profile');
  return omitUndefined({
    id,
    name: optionalString(rawBrowser.name, 'name'),
    readme: optionalString(rawBrowser.readme, 'readme'),
    browserConfigId: requiredString(rawBrowser.browserConfigId, 'browserConfigId'),
    appId: optionalString(rawBrowser.appId, 'appId'),
    proxyId,
    proxyIds,
    profile,
    sessionId: optionalString(rawBrowser.sessionId, 'sessionId'),
    createdAt: optionalString(rawBrowser.createdAt, 'createdAt'),
    updatedAt: optionalString(rawBrowser.updatedAt, 'updatedAt'),
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
    running: rawProxy.running === undefined ? undefined : Boolean(rawProxy.running),
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
    proxyLease: rawSession.proxyLease === undefined ? undefined : validateProxyLease(rawSession.proxyLease, `${name}.proxyLease`),
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
    browserId: optionalString(rawSession.browserId, 'browserId'),
    appId: optionalString(rawSession.appId, 'appId'),
    browserConfigId: optionalString(rawSession.browserConfigId, 'browserConfigId'),
    scope,
    taskId: rawSession.taskId === undefined ? undefined : requiredString(rawSession.taskId, 'taskId'),
    profile: requiredString(rawSession.profile, 'profile'),
    cdpUrl: requiredString(rawSession.cdpUrl, 'cdpUrl'),
    brokerUrl: requiredString(rawSession.brokerUrl, 'brokerUrl'),
    browserInstanceId: requiredString(rawSession.browserInstanceId, 'browserInstanceId'),
    browserStartedAt: optionalString(rawSession.browserStartedAt, 'browserStartedAt'),
    networkId: optionalString(rawSession.networkId, 'networkId'),
    proxyId: optionalString(rawSession.proxyId, 'proxyId'),
    proxyLease: rawSession.proxyLease === undefined ? undefined : validateProxyLease(rawSession.proxyLease, 'proxyLease'),
    proxyForwardId: optionalString(rawSession.proxyForwardId, 'proxyForwardId'),
    proxyServer: optionalString(rawSession.proxyServer, 'proxyServer'),
    activeTask: rawSession.activeTask === undefined ? undefined : validateActiveTask(rawSession.activeTask),
    lease: rawSession.lease === undefined ? undefined : validateSessionLease(rawSession.lease),
  });
}

function validateSessionLease(rawLease) {
  if (!rawLease || typeof rawLease !== 'object' || Array.isArray(rawLease)) {
    throwValidationError('lease must be an object');
  }
  return {
    leaseId: requiredString(rawLease.leaseId, 'lease.leaseId'),
    owner: requiredString(rawLease.owner, 'lease.owner'),
    agentId: optionalString(rawLease.agentId, 'lease.agentId'),
    taskId: optionalString(rawLease.taskId, 'lease.taskId'),
    claimedAt: requiredString(rawLease.claimedAt, 'lease.claimedAt'),
    heartbeatAt: requiredString(rawLease.heartbeatAt, 'lease.heartbeatAt'),
    expiresAt: requiredString(rawLease.expiresAt, 'lease.expiresAt'),
  };
}

function validateProxyLease(rawLease, name) {
  if (!rawLease || typeof rawLease !== 'object' || Array.isArray(rawLease)) {
    throwValidationError(`${name} must be an object`);
  }
  return {
    proxyId: requiredString(rawLease.proxyId, `${name}.proxyId`),
    sessionId: requiredString(rawLease.sessionId, `${name}.sessionId`),
    leasedAt: requiredString(rawLease.leasedAt, `${name}.leasedAt`),
    trafficStartTime: requiredString(rawLease.trafficStartTime, `${name}.trafficStartTime`),
  };
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
  ['/_pwdev/openapi/browser-configs.json', 'browser-configs.json'],
  ['/_pwdev/openapi/browsers.json', 'browsers.json'],
  ['/_pwdev/openapi/remote-brokers.json', 'remote-brokers.json'],
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

const OPENAPI_HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

/** Read and render a Markdown instruction template with explicit placeholders. */
function renderInstructionTemplate(name, values) {
  const template = readFileSync(path.join(INSTRUCTION_TEMPLATE_ROOT, name), 'utf8');
  const rendered = template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, key) => {
    if (!Object.hasOwn(values, key)) {
      throw new Error(`Missing instruction template value for ${placeholder}`);
    }
    return values[key];
  });
  const unresolved = rendered.match(/\{\{[A-Z_]+\}\}/);
  if (unresolved) throw new Error(`Unresolved instruction template placeholder ${unresolved[0]}`);
  return rendered.endsWith('\n') ? rendered : `${rendered}\n`;
}

/** Return the root catalog and each control-plane domain document it links. */
function controlPlaneOpenApiCatalog() {
  const rootUrl = '/_pwdev/openapi.json';
  const rootDocument = readOpenApiDocument(SERVER_PACKAGE_ROOT, SERVER_OPENAPI_DOCUMENTS.get(rootUrl));
  const catalog = [{
    url: rootUrl,
    whenToUse: rootDocument.info?.description,
    document: rootDocument,
  }];
  for (const entry of rootDocument['x-pwdev-documents'] ?? []) {
    const relativePath = SERVER_OPENAPI_DOCUMENTS.get(entry.url);
    if (!relativePath) throw new Error(`OpenAPI catalog links unknown document ${entry.url}`);
    catalog.push({
      url: entry.url,
      whenToUse: entry.whenToUse,
      document: readOpenApiDocument(SERVER_PACKAGE_ROOT, relativePath),
    });
  }
  return catalog;
}

/** Generate the instruction document list from the checked-in OpenAPI metadata. */
function renderOpenApiDocumentLinks(serverUrl) {
  const documents = [
    ...controlPlaneOpenApiCatalog(),
    {
      url: '/_pwdev/delegates/proxy/openapi.json',
      whenToUse: 'Create a managed proxy or change its lifecycle or rules.',
      document: readOpenApiDocument(PROXY_PACKAGE_ROOT, 'root.json'),
    },
    {
      url: '/_pwdev/delegates/broker/openapi.json',
      whenToUse: 'Use advanced broker capabilities not covered by the control plane.',
      document: readOpenApiDocument(BROKER_PACKAGE_ROOT, BROKER_OPENAPI_DOCUMENT),
    },
  ];
  return documents
    .map(({ url, whenToUse, document }) => {
      const title = document.info?.title ?? url;
      return `- [${title}](${serverUrl}${url})${whenToUse ? ` — ${whenToUse}` : ''}`;
    })
    .join('\n');
}

/** Generate the concise control-plane operation table from OpenAPI paths. */
function renderOpenApiEndpointSummary() {
  const operations = [];
  const seen = new Set();
  for (const { document } of controlPlaneOpenApiCatalog()) {
    for (const [apiPath, pathItem] of Object.entries(document.paths ?? {})) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!OPENAPI_HTTP_METHODS.has(method)) continue;
        const key = `${method}:${apiPath}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const summary = operation.summary
          ?? operation.description
          ?? operation.responses?.['200']?.description
          ?? operation.operationId;
        operations.push({ method: method.toUpperCase(), path: apiPath, summary });
      }
    }
  }
  const rows = operations.map(({ method, path: apiPath, summary }) =>
    `| ${method} | \`${apiPath}\` | ${String(summary).replace(/\|/g, '\\|').replace(/\s+/g, ' ')} |`);
  return ['| Method | Path | Purpose |', '| --- | --- | --- |', ...rows].join('\n');
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
  return renderInstructionTemplate('broker-delegate.md', { SERVER_URL: serverUrl });
}

function proxyDelegateInstructions(serverUrl) {
  return renderInstructionTemplate('proxy-delegate.md', { SERVER_URL: serverUrl });
}

function pwDevApi(serverUrl) {
  return {
    ok: true,
    version: 1,
    serverUrl,
    entities: {
      apps: { persistent: true, fields: ['id', 'name', 'worktree', 'branch', 'readme', 'accounts'] },
      proxies: { persistent: true, fields: ['id', 'appId', 'ruleset', 'proxyUrl'] },
      browserConfigs: { persistent: true, path: '/_pwdev/browser-configs', fields: ['id', 'name?', 'targetUrl?', 'brokerUrl?', 'profile?', 'ignoreSslErrors?', 'proxyBypassList?', 'headless?', 'resetProfile?'] },
      remoteBrokers: { persistent: false, path: '/_pwdev/remote-brokers', fields: ['id?', 'target', 'repository?', 'worktree?', 'revision?', 'remotePort?', 'localPort?'] },
      browsers: { persistent: true, path: '/_pwdev/browsers', fields: ['id', 'name?', 'browserConfigId', 'appId?', 'proxyId?', 'proxyIds?', 'profile?', 'readme?', 'sessionId?', 'occupancy?'] },
      sessions: { persistent: false, sourceOfTruth: 'broker', fields: ['sessionId', 'browserId?', 'browserConfigId?', 'appId?', 'scope?', 'profile?', 'browserInstanceId', 'cdpUrl', 'proxyId?', 'proxyLease?', 'lease?'] },
    },
    endpoints: [
      { method: 'GET', path: '/_pwdev/status', summary: 'Server and broker health' },
      { method: 'GET', path: '/_pwdev/env', summary: 'Live runtime constants' },
      { method: 'GET', path: '/_pwdev/instructions', summary: 'Concise workflow guide' },
      { method: 'GET', path: '/_pwdev/api', summary: 'Compact API index; use a detail route or POST filter for usage' },
      { method: 'POST', path: '/_pwdev/api', summary: 'Find one operation by JSON { method, path }' },
      { method: 'GET|POST', path: '/_pwdev/apps', summary: 'List or upsert app metadata' },
      { method: 'GET|PATCH|DELETE', path: '/_pwdev/apps/:id', summary: 'Inspect, patch, or delete app metadata' },
      { method: 'GET', path: '/_pwdev/apps/:id/manifest', summary: 'Read an app attach manifest' },
      { method: 'GET|POST', path: '/_pwdev/browser-configs', summary: 'List or upsert browser configs', body: { required: ['id'], optional: ['targetUrl', 'brokerUrl', 'profile', 'ignoreSslErrors', 'proxyBypassList', 'headless', 'resetProfile'] } },
      { method: 'GET|DELETE', path: '/_pwdev/browser-configs/:id', summary: 'Get or delete browser config' },
      { method: 'GET|POST', path: '/_pwdev/remote-brokers', summary: 'List or provision a remote broker SSH forward', body: { required: ['target'], optional: ['id', 'repository', 'worktree', 'revision', 'remotePort', 'localPort'] } },
      { method: 'DELETE', path: '/_pwdev/remote-brokers/:id', summary: 'Release one server-owned local SSH forward' },
      { method: 'POST', path: '/_pwdev/remote-brokers/:id/disconnect', summary: 'Release one server-owned local SSH forward' },
      { method: 'POST', path: '/_pwdev/remote-brokers/:id/stop', summary: 'Release the forward and stop its remote broker' },
      { method: 'GET|POST', path: '/_pwdev/browsers', summary: 'List or create reusable browsers', body: { required: ['id', 'browserConfigId'], optional: ['name', 'readme', 'appId', 'proxyId', 'proxyIds', 'profile'] } },
      { method: 'GET|DELETE', path: '/_pwdev/browsers/:id', summary: 'Inspect or destroy a browser' },
      { method: 'POST', path: '/_pwdev/browsers/:id/start', summary: 'Start the browser session using its derived profile and reserved proxy', body: { optional: ['lease: { owner, agentId?, taskId?, ttlMs? }'] } },
      { method: 'POST', path: '/_pwdev/browsers/:id/stop', summary: 'Stop the browser session while preserving its profile and proxy reservation' },
      { method: 'GET', path: '/_pwdev/sessions', summary: 'List live sessions' },
      { method: 'GET', path: '/_pwdev/sessions/:id', summary: 'Get live session' },
      { method: 'POST', path: '/_pwdev/sessions/:id/stop', summary: 'Stop live session' },
      { method: 'POST', path: '/_pwdev/sessions/:id/claim', summary: 'Claim a live session for one Playwright agent', body: { required: ['owner'], optional: ['agentId', 'taskId', 'ttlMs'] } },
      { method: 'POST', path: '/_pwdev/sessions/:id/heartbeat', summary: 'Extend the session lease', body: { required: ['leaseId'], optional: ['ttlMs'] } },
      { method: 'POST', path: '/_pwdev/sessions/:id/release', summary: 'Release the session lease without stopping Chrome', body: { required: ['leaseId'] } },
      { method: 'GET|POST|DELETE', path: '/_pwdev/browsers[/:id]', summary: 'Manage reusable browsers' },
      { method: 'POST', path: '/_pwdev/browsers/:id/start|stop', summary: 'Start or stop a browser session' },
      { method: 'GET|POST|DELETE', path: '/_pwdev/proxies[/:id]', summary: 'Manage proxy records' },
      { method: 'GET', path: '/_pwdev/proxies/:id/traffic', summary: 'Read a Whistle proxy traffic feed', query: ['count', 'dumpCount', 'startTime', 'lastRowId', 'ids', 'status', 'url', 'ip', 'name', 'value', 'name1/value1…name5/value5', 'mtype'] },
      { method: 'ANY', path: '/_pwdev/proxy/*', summary: 'Server-proxied managed proxy API' },
      { method: 'ANY', path: '/_pwdev/broker/*', summary: 'Server-proxied broker API' },
    ],
    details: {
      resources: ['apps', 'browserConfigs', 'browsers', 'proxies', 'sessions'],
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
      usage: 'Persisted project metadata. Register an app before linking it from a browser.',
      operations: [
        operation('GET', '/_pwdev/apps', 'List registered apps', 'Fetch the central app registry.', { method: 'GET', path: '/_pwdev/apps' }, ['The root manifest is not an app unless explicitly registered.'], { fields: ['ok', 'apps'] }),
        operation('POST', '/_pwdev/apps', 'Create or update an app', 'Send an app record; id is the stable upsert key.', { method: 'POST', path: '/_pwdev/apps', body: { id: 'checkout-main', appUrl: 'http://127.0.0.1:5173', readme: 'Run npm run dev first.' } }, ['Do not register production or personal credentials in accounts.'], { fields: ['ok', 'app'] }),
        operation('GET', '/_pwdev/apps/:id', 'Get one app', 'Read metadata for one registered app.', { method: 'GET', path: '/_pwdev/apps/checkout-main' }, ['Returns 404 for an unknown id.'], { fields: ['ok', 'app'] }),
        operation('PATCH', '/_pwdev/apps/:id', 'Patch app metadata', 'Update the mutable app attachment metadata.', { method: 'PATCH', path: '/_pwdev/apps/checkout-main', body: { proxyId: 'checkout-whistle' } }, ['Only proxyId can be patched.', 'Set proxyId to null to remove the app attachment.'], { fields: ['ok', 'app'] }),
        operation('DELETE', '/_pwdev/apps/:id', 'Delete an app', 'Remove one registered app record.', { method: 'DELETE', path: '/_pwdev/apps/checkout-main' }, ['Returns 404 for an unknown id.'], { fields: ['ok', 'id'] }),
        operation('GET', '/_pwdev/apps/:id/manifest', 'Get an app manifest', 'Read the app attach contract and operating metadata.', { method: 'GET', path: '/_pwdev/apps/checkout-main/manifest' }, ['A manifest does not itself start a browser.'], { fields: ['ok', 'id', 'appUrl', 'readme'] }),
      ],
    },
    browserConfigs: {
      usage: 'Persistent browser configs hold reusable Chrome launch configuration. Browsers reference them and own lifecycle.',
      operations: [
        operation('GET', '/_pwdev/browser-configs', 'List browser configs', 'Fetch all persisted browser configurations.', { method: 'GET', path: '/_pwdev/browser-configs' }, [], { fields: ['ok', 'browserConfigs'] }),
        operation('POST', '/_pwdev/browser-configs', 'Create or update a browser config', 'Send an id plus reusable target, profile, broker, and Chrome launch settings.', { method: 'POST', path: '/_pwdev/browser-configs', body: { id: 'checkout-chrome', profile: 'work-okta', headless: false } }, ['A browser config cannot be started directly.', 'Apps and proxies belong to browsers.', 'A referenced browser config cannot be edited.'], { fields: ['ok', 'browserConfig'] }),
        operation('GET', '/_pwdev/browser-configs/:id', 'Get one browser config', 'Read one reusable browser configuration.', { method: 'GET', path: '/_pwdev/browser-configs/checkout-chrome' }, ['Returns 404 for an unknown id.'], { fields: ['ok', 'browserConfig'] }),
        operation('DELETE', '/_pwdev/browser-configs/:id', 'Delete a browser config', 'Remove an unused browser configuration.', { method: 'DELETE', path: '/_pwdev/browser-configs/checkout-chrome' }, ['Blocked while a browser references the config.', 'Blocked while a live session uses the config.'], { fields: ['ok', 'id'] }),
      ],
    },
    browsers: {
      usage: 'Browsers compose one required browser config with an optional app and proxy, and own start/stop lifecycle.',
      operations: [
        operation('GET', '/_pwdev/browsers', 'List browsers', 'Fetch all durable browsers with resolved components.', { method: 'GET', path: '/_pwdev/browsers' }, [], { fields: ['ok', 'browsers'] }),
        operation('POST', '/_pwdev/browsers', 'Create or update a browser', 'Send an id and browserConfigId, plus optional appId and fixed or pooled proxy references.', { method: 'POST', path: '/_pwdev/browsers', body: { id: 'checkout-smoke', browserConfigId: 'checkout-chrome', appId: 'checkout-main', proxyIds: ['checkout-traffic-a', 'checkout-traffic-b'] } }, ['browserConfigId is required.', 'proxyId and proxyIds are mutually exclusive.'], { fields: ['ok', 'browser'] }),
        operation('POST', '/_pwdev/browsers/:id/start', 'Start a browser', 'Start the browser using its config and launch its managed Whistle proxy on demand.', { method: 'POST', path: '/_pwdev/browsers/checkout-smoke/start' }, ['Connect Playwright to response.session.cdpUrl.', 'Only one session can occupy a browser.'], { fields: ['ok', 'browser', 'session', 'start'] }),
        operation('POST', '/_pwdev/browsers/:id/stop', 'Stop a browser', 'Stop its session and idle managed Whistle proxy while preserving profiles and reservations.', { method: 'POST', path: '/_pwdev/browsers/checkout-smoke/stop' }, [], { fields: ['ok', 'browser', 'releasedSession?', 'proxyStop?'] }),
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
        operation('POST', '/_pwdev/proxy/proxies', 'Create a managed Whistle proxy', 'Create a stopped durable profile; starting a browser that references it launches Whistle on demand.', { method: 'POST', path: '/_pwdev/proxy/proxies', body: { id: 'checkout-whistle', taskId: 'smoke-login', ruleset: 'example.com 127.0.0.1:3000' } }, ['Use /_pwdev/proxy/* rather than the proxy-manager port.', 'Managed proxy profiles are durable and reusable; delete one only when its retained profile is no longer wanted.'], { fields: ['ok', 'proxy'] }),
      ],
    },
    sessions: {
      usage: 'Live, broker-owned runtime records. They are removed after broker restart or explicit stop.',
      operations: [
        operation('GET', '/_pwdev/sessions', 'List live sessions', 'Fetch and reconcile active broker sessions.', { method: 'GET', path: '/_pwdev/sessions' }, [], { fields: ['ok', 'sessions'] }),
        operation('GET', '/_pwdev/sessions/:id', 'Get one live session', 'Read one broker-backed session and its related app metadata.', { method: 'GET', path: '/_pwdev/sessions/checkout-smoke__default' }, ['Returns 404 when the broker no longer reports the session.'], { fields: ['ok', 'session', 'app?', 'serverUrl'] }),
        operation('POST', '/_pwdev/sessions/:id/stop', 'Stop a live session', 'Stop directly by session id when the owning browser route is not convenient.', { method: 'POST', path: '/_pwdev/sessions/checkout-tax__default/stop' }, ['Does not delete the persistent browser, browser config, or durable proxy profile.'], { fields: ['ok', 'session'] }),
      ],
    },
  };
}

function pwDevInstructions(serverUrl) {
  return renderInstructionTemplate('agent.md', {
    SERVER_URL: serverUrl,
    API_DOCUMENTS: renderOpenApiDocumentLinks(serverUrl),
    API_ENDPOINTS: renderOpenApiEndpointSummary(),
  });
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

export async function upsertPwDevBrowserConfig(browserConfig, { serverUrl = '${serverUrl}' } = {}) {
  if (!browserConfig?.id) throw new Error('upsertPwDevBrowserConfig requires browserConfig.id');
  const response = await fetch(\`\${serverUrl}/_pwdev/browser-configs\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(browserConfig),
  });
  if (!response.ok) throw new Error(\`pw-dev browser config upsert failed: \${response.status} \${await response.text()}\`);
  return response.json();
}

export async function loadPwDevBrowserConfig({ serverUrl = '${serverUrl}', browserConfigId } = {}) {
  if (!browserConfigId) throw new Error('loadPwDevBrowserConfig requires browserConfigId');
  const response = await fetch(\`\${serverUrl}/_pwdev/browser-configs/\${encodeURIComponent(browserConfigId)}\`);
  if (!response.ok) throw new Error(\`pw-dev browser config load failed: \${response.status} \${await response.text()}\`);
  return response.json();
}

export async function upsertPwDevBrowser(browser, { serverUrl = '${serverUrl}' } = {}) {
  if (!browser?.id || !browser?.browserConfigId) throw new Error('upsertPwDevBrowser requires browser.id and browser.browserConfigId');
  const response = await fetch(\`\${serverUrl}/_pwdev/browsers\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(browser),
  });
  if (!response.ok) throw new Error(\`pw-dev browser upsert failed: \${response.status} \${await response.text()}\`);
  return response.json();
}

export async function loadPwDevBrowser({ serverUrl = '${serverUrl}', browserId } = {}) {
  if (!browserId) throw new Error('loadPwDevBrowser requires browserId');
  const response = await fetch(\`\${serverUrl}/_pwdev/browsers/\${encodeURIComponent(browserId)}\`);
  if (!response.ok) throw new Error(\`pw-dev browser load failed: \${response.status} \${await response.text()}\`);
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
  const browserRecord = result.browser ?? result;
  const session = result.session ?? browserRecord.components?.session;
  if (!session?.cdpUrl) {
    throw new Error('pw-dev browser has no live session cdpUrl');
  }

  const browser = await chromium.connectOverCDP(session.cdpUrl);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.newPage();

  return { browserRecord, session, browser, context, page };
}
`;
}
