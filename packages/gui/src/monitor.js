// @ts-check

import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MAX_PATH_LENGTH = 80;
const ALLOWED_ACTIONS = new Set(['click', 'focus', 'highlight', 'scrollIntoView']);
const NAVIGATION_RETRY_DELAY_MS = 25;
const MAX_NAVIGATION_RETRIES = 3;
const PREVIEW_TIMEOUT_MS = 2_000;
const PAGE_INVENTORY_INTERVAL_MS = 1_000;
const IDLE_CONNECTION_TIMEOUT_MS = 5_000;

/**
 * Keeps one Playwright/CDP observer per monitored browser session. The GUI
 * attaches to the existing session; it never launches a second browser.
 */
export class BrowserMonitorHub {
  /** @param {{ pwDevUrl: string, connectOverCDP?: (cdpUrl: string) => Promise<any>, fetchJson?: (url: string) => Promise<any> }} options */
  constructor({ pwDevUrl, connectOverCDP, fetchJson: fetchJsonImpl = fetchJson }) {
    this.pwDevUrl = pwDevUrl;
    this.connectOverCDP = connectOverCDP;
    this.fetchJson = fetchJsonImpl;
    /** @type {Map<string, MonitorConnection>} */
    this.connections = new Map();
    /** @type {Map<string, Promise<Buffer>>} */
    this.previewPromises = new Map();
  }

  async stream(browserId, pageId, req, res) {
    const connection = await this.ensureConnection(browserId, pageId);
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    // A monitor tab may attach to a connection that has remained alive while
    // the browser navigated elsewhere. Refresh before sending the cached page
    // metadata so a newly opened tab never starts with stale dimensions.
    await this.refresh(connection);
    res.writeHead(200, {
      'cache-control': 'no-store',
      'connection': 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    });
    connection.subscribers.add(res);
    const initialPages = await this.refreshPageInventory(connection);
    this.writeEvent(res, { type: 'connected', browserId, sessionId: connection.sessionId, pageId: connection.pageId, pages: initialPages });
    this.writeEvent(res, connection.lastPageState ?? { type: 'state', status: 'connecting', browserId });
    const keepAlive = setInterval(() => {
      if (!res.destroyed) res.write(': keep-alive\n\n');
    }, 15_000);
    const pageInventory = setInterval(() => {
      void this.refreshPageInventory(connection)
        .then((pages) => {
          if (!res.destroyed && !res.writableEnded) this.writeEvent(res, { type: 'pages', browserId, sessionId: connection.sessionId, pageId: connection.pageId, pages });
        })
        .catch((error) => {
          if (!res.destroyed && !res.writableEnded) this.writeEvent(res, { type: 'error', error: error?.message ?? String(error) });
        });
    }, PAGE_INVENTORY_INTERVAL_MS);
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(keepAlive);
      clearInterval(pageInventory);
      connection.subscribers.delete(res);
      if (connection.subscribers.size === 0) void this.closeConnection(connection);
    };
    let cleaned = false;
    req.once('close', cleanup);
    res.once('close', cleanup);
  }

  async action(browserId, pageId, payload) {
    const connection = await this.ensureConnection(browserId, pageId);
    const action = payload?.action;
    if (!ALLOWED_ACTIONS.has(action)) throw httpError(400, `Unsupported monitor action: ${action}`);
    const path = validateNodePath(payload?.path);
    if (action === 'scrollIntoView' && payload?.behavior !== undefined && !['auto', 'smooth'].includes(payload.behavior)) {
      throw httpError(400, 'behavior must be auto or smooth');
    }
    const result = await connection.page.evaluate(({ action: requestedAction, path: nodePath, behavior }) => {
      let node = document.documentElement;
      for (const index of nodePath) {
        if (!node?.childNodes?.[index]) throw new Error('DOM path no longer exists');
        node = node.childNodes[index];
      }
      if (!(node instanceof Element)) throw new Error('DOM path does not point to an element');
      if (requestedAction === 'click') node.click();
      else if (requestedAction === 'focus') node.focus();
      else if (requestedAction === 'scrollIntoView') node.scrollIntoView({ behavior: behavior ?? 'smooth', block: 'center', inline: 'center' });
      else {
        node.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        const previous = node.getAttribute('data-pwdev-monitor-highlight');
        node.setAttribute('data-pwdev-monitor-highlight', 'true');
        setTimeout(() => {
          if (previous === null) node.removeAttribute('data-pwdev-monitor-highlight');
          else node.setAttribute('data-pwdev-monitor-highlight', previous);
        }, 1500);
      }
      return { tagName: node.tagName, text: (node.textContent ?? '').trim().slice(0, 240) };
    }, { action, path, behavior: payload?.behavior });
    return { ok: true, action, path, result };
  }

  preview(browserId, pageId) {
    const key = monitorKey(browserId, pageId);
    const existing = this.previewPromises.get(key);
    if (existing) return existing;
    const capture = this.capturePreview(browserId, pageId).finally(() => {
      if (this.previewPromises.get(key) === capture) this.previewPromises.delete(key);
      const connection = this.connections.get(key);
      if (connection?.subscribers.size === 0) this.scheduleIdleClose(connection);
    });
    this.previewPromises.set(key, capture);
    return capture;
  }

  async capturePreview(browserId, pageId) {
    const connection = await this.ensureConnection(browserId, pageId);
    if (connection.page.isClosed()) throw httpError(409, 'Browser session has no page to monitor');
    return connection.page.screenshot({
      type: 'jpeg',
      quality: 60,
      scale: 'css',
      timeout: PREVIEW_TIMEOUT_MS,
    });
  }

  async close() {
    const connections = [...new Set(this.connections.values())];
    this.connections.clear();
    this.previewPromises.clear();
    await Promise.all(connections.map(async (connection) => {
      for (const subscriber of connection.subscribers) subscriber.end();
      connection.subscribers.clear();
      if (connection.idleTimer) clearTimeout(connection.idleTimer);
      try {
        await connection.browser.close();
      } catch {
        // The browser session may already have disconnected or stopped.
      }
    }));
  }

  async ensureConnection(browserId, pageId) {
    const key = monitorKey(browserId, pageId);
    const existing = this.connections.get(key);
    if (existing?.browser.isConnected()) {
      if (existing.idleTimer) clearTimeout(existing.idleTimer);
      return existing;
    }
    if (existing) this.connections.delete(key);

    const browserRecord = await this.fetchJson(`${this.pwDevUrl}/_pwdev/browsers/${encodeURIComponent(browserId)}`);
    const session = browserRecord.body?.browser?.components?.session
      ?? browserRecord.body?.browser?.runtime
      ?? browserRecord.body?.browser?.sessions?.[0];
    if (!browserRecord.ok || !session?.cdpUrl) {
      throw httpError(browserRecord.statusCode === 404 ? 404 : 409, session ? 'Browser has no live session' : browserRecord.error || 'Browser has no live session');
    }
    let connectOverCDP = this.connectOverCDP;
    if (!connectOverCDP) {
      try {
        const chromium = require('playwright').chromium;
        connectOverCDP = (cdpUrl) => chromium.connectOverCDP(cdpUrl);
      } catch (error) {
        throw httpError(503, `Live screenshot monitor requires Playwright: ${error.message}`);
      }
    }
    const browser = await connectOverCDP(session.cdpUrl);
    const pages = await this.describePages(browser);
    const selected = pageId ? pages.find((entry) => entry.id === pageId) : pages[0];
    const page = selected?.page;
    if (!page) {
      await browser.close();
      throw httpError(409, 'Browser session has no page to monitor');
    }
    const connection = {
      browserId,
      sessionId: session.sessionId,
      pageId: selected.id,
      browser,
      page,
      subscribers: new Set(),
      observedPages: new WeakSet(),
      lastPageState: undefined,
      bindingName: `__pwdevMonitor_${browserId.replace(/[^A-Za-z0-9_$]/g, '_')}_${Date.now()}`,
    };
    this.connections.set(key, connection);
    if (!pageId) this.connections.set(monitorKey(browserId, selected.id), connection);
    browser.on('disconnected', () => {
      if (![...this.connections.values()].includes(connection)) return;
      this.forgetConnection(connection);
      this.broadcast(connection, { type: 'disconnected', browserId, reason: 'browser disconnected' });
    });
    this.observePage(connection, page);
    await this.refresh(connection);
    return connection;
  }

  async refresh(connection) {
    connection.refreshRequested = true;
    if (connection.refreshPromise) return connection.refreshPromise;
    connection.refreshPromise = this.drainRefresh(connection)
      .catch((error) => this.reportRefreshError(connection, error))
      .finally(() => {
        connection.refreshPromise = undefined;
      });
    return connection.refreshPromise;
  }

  async drainRefresh(connection) {
    let retries = 0;
    while (connection.refreshRequested && this.isConnectionActive(connection)) {
      connection.refreshRequested = false;
      try {
        const pageState = await this.attachPageObserver(connection);
        connection.lastPageState = { type: 'page', browserId: connection.browserId, ...pageState };
        this.broadcast(connection, connection.lastPageState);
        retries = 0;
      } catch (error) {
        if (isTransientNavigationError(error) && retries < MAX_NAVIGATION_RETRIES) {
          retries += 1;
          await delay(NAVIGATION_RETRY_DELAY_MS);
          connection.refreshRequested = true;
          continue;
        }
        this.reportRefreshError(connection, error);
      }
    }
  }

  isConnectionActive(connection) {
    return [...this.connections.values()].includes(connection)
      && connection.browser.isConnected()
      && !connection.page.isClosed();
  }

  async describePages(browser) {
    const pages = browser.contexts().flatMap((context) => context.pages()).filter((page) => !page.isClosed());
    return Promise.all(pages.map(async (page) => {
      const session = await page.context().newCDPSession(page);
      try {
        const result = await session.send('Target.getTargetInfo');
        return { id: result.targetInfo.targetId, title: await page.title().catch(() => ''), url: page.url(), page };
      } finally {
        await session.detach().catch(() => undefined);
      }
    }));
  }

  async describeSessionPages(connection) {
    if (connection.sessionId) {
      const result = await this.fetchJson(`${this.pwDevUrl}/_pwdev/sessions/${encodeURIComponent(connection.sessionId)}/pages`);
      if (result.ok && Array.isArray(result.body?.pages)) return result.body.pages;
    }
    return (await this.describePages(connection.browser)).map(({ page, ...description }) => description);
  }

  async refreshPageInventory(connection) {
    const localPages = await this.describePages(connection.browser);
    let selected = localPages.find((entry) => entry.id === connection.pageId);
    if (!selected && localPages.length) {
      selected = localPages[0];
      const oldPageKey = monitorKey(connection.browserId, connection.pageId);
      connection.page = selected.page;
      connection.pageId = selected.id;
      if (this.connections.get(oldPageKey) === connection) this.connections.delete(oldPageKey);
      const nextPageKey = monitorKey(connection.browserId, selected.id);
      if (!this.connections.has(nextPageKey)) this.connections.set(nextPageKey, connection);
      this.observePage(connection, selected.page);
      await this.refresh(connection);
    }
    const remotePages = await this.describeSessionPages(connection);
    const remoteById = new Map(remotePages.map((page) => [page.id, page]));
    return localPages.map(({ page, ...description }) => ({ ...description, ...remoteById.get(description.id) }));
  }

  observePage(connection, page) {
    if (connection.observedPages.has(page)) return;
    connection.observedPages.add(page);
    // Navigation events can arrive while a previous evaluate is still in
    // flight. Route each event through one serialized, non-throwing refresh
    // so an execution-context race cannot become an unhandled rejection.
    page.on('domcontentloaded', () => void this.refresh(connection));
    page.on('load', () => void this.refresh(connection));
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) void this.refresh(connection);
    });
  }

  scheduleIdleClose(connection) {
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    connection.idleTimer = setTimeout(() => {
      if (connection.subscribers.size === 0) void this.closeConnection(connection);
    }, IDLE_CONNECTION_TIMEOUT_MS);
    connection.idleTimer.unref?.();
  }

  async closeConnection(connection) {
    if (connection.closing) return;
    connection.closing = true;
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    this.forgetConnection(connection);
    try {
      await connection.browser.close();
    } catch {
      // The browser session may already have disconnected or stopped.
    }
  }

  forgetConnection(connection) {
    for (const [key, candidate] of this.connections) {
      if (candidate === connection) this.connections.delete(key);
    }
  }

  reportRefreshError(connection, error) {
    this.broadcast(connection, { type: 'error', error: error?.message ?? String(error) });
  }

  async attachPageObserver(connection) {
    if (connection.page.isClosed()) return;
    try {
      await connection.page.exposeFunction(connection.bindingName, (event) => this.handlePageEvent(connection, event));
    } catch (error) {
      if (!String(error?.message).includes('has been already registered')) throw error;
    }
    return connection.page.evaluate(({ bindingName }) => {
      window.__pwdevMonitorCleanup?.();
      const send = (event) => {
        try { Promise.resolve(window[bindingName](event)).catch(() => {}); } catch { /* monitor disconnected */ }
      };
      const viewport = () => send({
        type: 'viewport',
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        scroll: { x: scrollX, y: scrollY },
      });
      const click = (event) => send({
        type: 'click',
        x: event.clientX,
        y: event.clientY,
        button: event.button,
        trusted: event.isTrusted,
        viewport: { width: innerWidth, height: innerHeight },
      });
      addEventListener('scroll', viewport, { passive: true });
      addEventListener('resize', viewport, { passive: true });
      addEventListener('click', click, true);
      window.__pwdevMonitorCleanup = () => {
        removeEventListener('scroll', viewport);
        removeEventListener('resize', viewport);
        removeEventListener('click', click, true);
      };
      viewport();
      return {
        url: location.href,
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        scroll: { x: scrollX, y: scrollY },
        capturedAt: new Date().toISOString(),
      };
    }, { bindingName: connection.bindingName });
  }

  handlePageEvent(connection, event) {
    if (!event || typeof event !== 'object') return;
    this.broadcast(connection, { ...event, browserId: connection.browserId });
  }

  broadcast(connection, event) {
    for (const subscriber of connection.subscribers) {
      if (subscriber.destroyed) {
        connection.subscribers.delete(subscriber);
        continue;
      }
      this.writeEvent(subscriber, event);
    }
  }

  writeEvent(res, event) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

function validateNodePath(rawPath) {
  if (!Array.isArray(rawPath) || rawPath.length > MAX_PATH_LENGTH || rawPath.some((value) => !Number.isInteger(value) || value < 0 || value > 100000)) {
    throw httpError(400, 'path must be an array of DOM child indexes');
  }
  return rawPath;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isTransientNavigationError(error) {
  return /Execution context was destroyed|Cannot find context with specified id|Frame was detached/i.test(error?.message ?? String(error));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function monitorKey(browserId, pageId) {
  return pageId ? `${browserId}:${pageId}` : browserId;
}

function fetchJson(rawUrl) {
  const url = new URL(rawUrl);
  return new Promise((resolve) => {
    const request = http.request(url, { headers: { accept: 'application/json' } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let body;
        try { body = text ? JSON.parse(text) : {}; } catch { body = { ok: false, error: text }; }
        resolve({
          ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300 && body?.ok !== false,
          statusCode: response.statusCode ?? 0,
          body,
          error: body?.error,
        });
      });
    });
    request.setTimeout(2500, () => request.destroy(new Error('request timed out')));
    request.once('error', (error) => resolve({ ok: false, statusCode: 0, body: {}, error: error.message }));
    request.end();
  });
}

/** @typedef {{ browserId: string, sessionId?: string, pageId: string, browser: any, page: any, subscribers: Set<import('node:http').ServerResponse>, observedPages: WeakSet<any>, lastPageState?: Record<string, unknown>, bindingName: string, refreshRequested?: boolean, refreshPromise?: Promise<void>, idleTimer?: NodeJS.Timeout, closing?: boolean }} MonitorConnection */
