// @ts-check

import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MAX_PATH_LENGTH = 80;
const ALLOWED_ACTIONS = new Set(['click', 'focus', 'highlight', 'scrollIntoView']);
const NAVIGATION_RETRY_DELAY_MS = 25;
const MAX_NAVIGATION_RETRIES = 3;

/**
 * Keeps one Playwright/CDP observer per monitored browser session. The GUI
 * attaches to the existing session; it never launches a second browser.
 */
export class BrowserMonitorHub {
  /** @param {{ pwDevUrl: string }} options */
  constructor({ pwDevUrl }) {
    this.pwDevUrl = pwDevUrl;
    /** @type {Map<string, MonitorConnection>} */
    this.connections = new Map();
  }

  async stream(browserId, req, res) {
    const connection = await this.ensureConnection(browserId);
    // A monitor tab may attach to a connection that has remained alive while
    // the browser navigated elsewhere. Refresh before sending the cached
    // snapshot so a newly opened or refreshed tab never starts with stale DOM.
    await this.refresh(connection);
    res.writeHead(200, {
      'cache-control': 'no-store',
      'connection': 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    });
    connection.subscribers.add(res);
    this.writeEvent(res, { type: 'connected', browserId });
    this.writeEvent(res, connection.lastSnapshot ?? { type: 'state', status: 'connecting', browserId });
    const keepAlive = setInterval(() => {
      if (!res.destroyed) res.write(': keep-alive\n\n');
    }, 15_000);
    const cleanup = () => {
      clearInterval(keepAlive);
      connection.subscribers.delete(res);
    };
    req.once('close', cleanup);
    res.once('close', cleanup);
  }

  async action(browserId, payload) {
    const connection = await this.ensureConnection(browserId);
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

  async preview(browserId) {
    const connection = await this.ensureConnection(browserId);
    if (connection.page.isClosed()) throw httpError(409, 'Browser session has no page to monitor');
    return connection.page.screenshot({ type: 'jpeg', quality: 60, scale: 'css' });
  }

  async close() {
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(connections.map(async (connection) => {
      for (const subscriber of connection.subscribers) subscriber.end();
      connection.subscribers.clear();
      try {
        await connection.browser.close();
      } catch {
        // The browser session may already have disconnected or stopped.
      }
    }));
  }

  async ensureConnection(browserId) {
    const existing = this.connections.get(browserId);
    if (existing?.browser.isConnected()) return existing;
    if (existing) this.connections.delete(browserId);

    const browserRecord = await fetchJson(`${this.pwDevUrl}/_pwdev/browsers/${encodeURIComponent(browserId)}`);
    const session = browserRecord.body?.browser?.components?.session
      ?? browserRecord.body?.browser?.runtime
      ?? browserRecord.body?.browser?.sessions?.[0];
    if (!browserRecord.ok || !session?.cdpUrl) {
      throw httpError(browserRecord.statusCode === 404 ? 404 : 409, session ? 'Browser has no live session' : browserRecord.error || 'Browser has no live session');
    }
    let playwright;
    try {
      playwright = require('playwright');
    } catch (error) {
      throw httpError(503, `Live DOM monitor requires Playwright: ${error.message}`);
    }
    const browser = await playwright.chromium.connectOverCDP(session.cdpUrl);
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) {
      await browser.close();
      throw httpError(409, 'Browser session has no page to monitor');
    }
    const connection = {
      browserId,
      sessionId: session.sessionId,
      browser,
      page,
      subscribers: new Set(),
      lastSnapshot: undefined,
      bindingName: `__pwdevMonitor_${browserId.replace(/[^A-Za-z0-9_$]/g, '_')}_${Date.now()}`,
    };
    this.connections.set(browserId, connection);
    browser.on('disconnected', () => {
      if (this.connections.get(browserId) !== connection) return;
      this.connections.delete(browserId);
      this.broadcast(connection, { type: 'disconnected', browserId, reason: 'browser disconnected' });
    });
    // Navigation events can arrive while a previous evaluate is still in
    // flight. Route each event through one serialized, non-throwing refresh
    // so an execution-context race cannot become an unhandled rejection.
    page.on('domcontentloaded', () => void this.refresh(connection));
    page.on('load', () => void this.refresh(connection));
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) void this.refresh(connection);
    });
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
        await this.attachPageObserver(connection);
        await this.emitSnapshot(connection);
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
    return this.connections.get(connection.browserId) === connection
      && connection.browser.isConnected()
      && !connection.page.isClosed();
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
    await connection.page.evaluate(({ bindingName }) => {
      window.__pwdevMonitorCleanup?.();
      const pathOf = (node) => {
        const path = [];
        while (node && node !== document.documentElement) {
          const parent = node.parentNode;
          if (!parent) break;
          path.unshift(Array.prototype.indexOf.call(parent.childNodes, node));
          node = parent;
        }
        return path;
      };
      const styles = () => [...document.styleSheets].map((sheet) => {
        let text = '';
        try { text = [...sheet.cssRules].map((rule) => rule.cssText).join('\n'); } catch { /* cross-origin sheet */ }
        return { href: sheet.href, text };
      }).filter((sheet) => sheet.href || sheet.text);
      const send = (event) => {
        try { window[bindingName](event); } catch { /* monitor disconnected */ }
      };
      let pending = [];
      let flushTimer;
      const flush = () => {
        flushTimer = undefined;
        const patches = new Map();
        for (const record of pending.splice(0)) {
          const target = record.type === 'characterData' ? record.target.parentElement : record.target;
          if (!(target instanceof Element)) continue;
          const path = pathOf(target);
          patches.set(JSON.stringify(path), {
            path,
            mode: record.type === 'childList' ? 'innerHTML' : 'outerHTML',
            html: record.type === 'childList' ? target.innerHTML : target.outerHTML,
          });
        }
        if (patches.size) send({ type: 'patches', patches: [...patches.values()] });
        if (pending.length) flushTimer = setTimeout(flush, 50);
      };
      const observer = new MutationObserver((records) => {
        pending.push(...records);
        if (!flushTimer) flushTimer = setTimeout(flush, 50);
        if (records.some((record) => record.target === document.head || record.target.parentNode === document.head)) {
          send({ type: 'styles', styles: styles() });
        }
      });
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
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
        observer.disconnect();
        removeEventListener('scroll', viewport);
        removeEventListener('resize', viewport);
        removeEventListener('click', click, true);
        if (flushTimer) clearTimeout(flushTimer);
      };
      viewport();
      send({ type: 'styles', styles: styles() });
    }, { bindingName: connection.bindingName });
  }

  async emitSnapshot(connection) {
    if (connection.page.isClosed()) return;
    const snapshot = await connection.page.evaluate(() => ({
      type: 'snapshot',
      url: location.href,
      title: document.title,
      html: document.documentElement.outerHTML,
      styles: [...document.styleSheets].map((sheet) => {
        let text = '';
        try { text = [...sheet.cssRules].map((rule) => rule.cssText).join('\n'); } catch { /* cross-origin sheet */ }
        return { href: sheet.href, text };
      }).filter((sheet) => sheet.href || sheet.text),
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      scroll: { x: scrollX, y: scrollY },
      capturedAt: new Date().toISOString(),
    }));
    connection.lastSnapshot = snapshot;
    this.broadcast(connection, snapshot);
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

/** @typedef {{ browserId: string, sessionId?: string, browser: any, page: any, subscribers: Set<import('node:http').ServerResponse>, lastSnapshot?: Record<string, unknown>, bindingName: string, refreshRequested?: boolean, refreshPromise?: Promise<void> }} MonitorConnection */
