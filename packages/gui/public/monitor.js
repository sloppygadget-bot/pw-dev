const browserId = decodeURIComponent(location.pathname.split('/')[2] || '');
let pageId = new URLSearchParams(location.search).get('pageId');
const monitorUrl = (suffix) => `/api/monitor/${encodeURIComponent(browserId)}/${suffix}${pageId ? `?pageId=${encodeURIComponent(pageId)}` : ''}`;
let eventSource;
const image = document.querySelector('#mirror-image');
const imageWrap = document.querySelector('#mirror-frame-wrap');
const empty = document.querySelector('#mirror-empty');
const clickMarker = document.querySelector('#mirror-click-marker');
const status = document.querySelector('#monitor-status');
const title = document.querySelector('#monitor-title');
const subtitle = document.querySelector('#monitor-subtitle');
const navTargetUrl = document.querySelector('#nav-target-url');
const refreshButton = document.querySelector('#refresh-screenshot');
const maximizeButton = document.querySelector('#maximize-monitor');
const backButton = document.querySelector('#nav-back');
const forwardButton = document.querySelector('#nav-forward');
const reloadButton = document.querySelector('#nav-reload');
const pageTabs = document.querySelector('#page-tabs');
const pageSummary = document.querySelector('#page-summary');
const inputMeta = document.querySelector('#input-meta');
const SCREENSHOT_INTERVAL_MS = 1_000;
const INPUT_ERROR_VISIBILITY_MS = 3_000;
const WHEEL_LINE_HEIGHT_PX = 16;
const BUTTON_NAMES = ['left', 'middle', 'right'];
const state = {
  hasTarget: false,
  targetGeneration: 0,
  previewUrl: undefined,
  refreshTimer: undefined,
  refreshing: false,
  viewport: undefined,
  lastClick: undefined,
  actionQueue: [],
  actionSending: false,
  pendingPointerMove: undefined,
  pointerMoveFrame: undefined,
  pressedKeys: new Set(),
  suppressedKeyUps: new Set(),
  activePointer: undefined,
  inputErrorUntil: 0,
  inputErrorTimer: undefined,
  pageTabOffset: 0,
  pageTabSelectedId: undefined,
  pages: [],
  sessionId: undefined,
  previewCache: new Map(),
  captureController: undefined,
  actionController: undefined,
};

title.textContent = `Screenshot monitor — ${browserId}`;
setTargetControls(false);

connectMonitorStream();
refreshButton.addEventListener('click', () => void refreshScreenshot());
maximizeButton.addEventListener('click', () => setMaximized(!document.body.classList.contains('monitor-maximized')));
let restoreEscape = false;
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !document.body.classList.contains('monitor-maximized')) return;
  restoreEscape = true;
  event.preventDefault();
  event.stopImmediatePropagation();
  setMaximized(false);
}, true);
document.addEventListener('keyup', (event) => {
  if (event.key !== 'Escape' || !restoreEscape) return;
  restoreEscape = false;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
backButton.addEventListener('click', () => sendAction({ action: 'navigation', type: 'back' }));
forwardButton.addEventListener('click', () => sendAction({ action: 'navigation', type: 'forward' }));
reloadButton.addEventListener('click', () => sendAction({ action: 'navigation', type: 'reload' }));
imageWrap.addEventListener('pointermove', handlePointerMove);
imageWrap.addEventListener('pointerdown', handlePointerDown);
imageWrap.addEventListener('pointerup', handlePointerUp);
imageWrap.addEventListener('pointercancel', handlePointerCancel);
imageWrap.addEventListener('wheel', handleWheel, { passive: false });
imageWrap.addEventListener('contextmenu', (event) => event.preventDefault());
imageWrap.addEventListener('keydown', handleKeyDown);
imageWrap.addEventListener('keyup', handleKeyUp);
imageWrap.addEventListener('paste', handlePaste);
imageWrap.addEventListener('blur', releasePressedKeys);
image.addEventListener('load', () => {
  if (!state.hasTarget) return;
  empty.classList.add('hidden');
  placeClickMarker(state.lastClick);
});
window.addEventListener('resize', () => placeClickMarker(state.lastClick));
window.addEventListener('popstate', () => {
  const nextPageId = new URLSearchParams(location.search).get('pageId');
  if (nextPageId !== pageId) selectPage(nextPageId, { updateHistory: false });
});
window.addEventListener('beforeunload', () => {
  eventSource?.close();
  eventSource = undefined;
  state.hasTarget = false;
  state.targetGeneration += 1;
  state.captureController?.abort();
  state.actionController?.abort();
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  if (state.pointerMoveFrame) cancelAnimationFrame(state.pointerMoveFrame);
  if (state.inputErrorTimer) clearTimeout(state.inputErrorTimer);
  clearMonitorPreviewCache();
});

function connectMonitorStream() {
  eventSource?.close();
  const source = new EventSource(monitorUrl('events'));
  eventSource = source;
  source.addEventListener('message', (event) => {
    if (eventSource !== source) return;
    try {
      handleEvent(JSON.parse(event.data));
    } catch {
      clearTarget('Monitor error', 'Reload this monitor to reconnect.');
    }
  });
  source.onerror = () => {
    if (eventSource === source) clearTarget('Disconnected', 'Waiting to reconnect…');
  };
}

function clearMonitorPreviewCache() {
  for (const entry of state.previewCache.values()) URL.revokeObjectURL(entry.url);
  state.previewCache.clear();
  state.previewUrl = undefined;
}

function displayMonitorPreview(entry) {
  state.previewUrl = entry.url;
  image.src = entry.url;
  image.classList.remove('hidden');
  empty.classList.add('hidden');
  imageWrap.style.setProperty('--mirror-aspect', `${entry.width} / ${entry.height}`);
}

function showCachedMonitorPreview() {
  const entry = state.previewCache.get(pageId);
  if (!entry) return;
  state.previewCache.delete(pageId);
  state.previewCache.set(pageId, entry);
  displayMonitorPreview(entry);
}

function pruneMonitorPreviewCache(pages) {
  const urls = new Map(pages.map((page) => [page.id, page.url]));
  for (const [id, entry] of state.previewCache) {
    if (urls.has(id) && urls.get(id) === entry.pageUrl) continue;
    URL.revokeObjectURL(entry.url);
    state.previewCache.delete(id);
    if (state.previewUrl === entry.url) {
      state.previewUrl = undefined;
      image.removeAttribute('src');
      image.classList.add('hidden');
      empty.textContent = 'Loading screenshot…';
      empty.classList.remove('hidden');
    }
  }
}

function setMaximized(maximized) {
  releasePressedKeys();
  document.body.classList.toggle('monitor-maximized', maximized);
  maximizeButton.textContent = maximized ? 'Restore' : 'Maximize';
  maximizeButton.title = maximized ? 'Restore view (Escape)' : 'Fill window';
  maximizeButton.setAttribute('aria-pressed', String(maximized));
  if (maximized) imageWrap.focus({ preventScroll: true });
  else maximizeButton.focus({ preventScroll: true });
  placeClickMarker(state.lastClick);
}

function handleEvent(event) {
  if (event.type === 'no-target') {
    eventSource?.close();
    eventSource = undefined;
    pageId = null;
    const next = new URL(location.href);
    next.searchParams.delete('pageId');
    history.replaceState(null, '', next);
    clearTarget('No target page', 'Open a target page, then reload this monitor.');
    return;
  }
  if (event.type === 'error' || event.type === 'disconnected') {
    clearTarget(event.type === 'error' ? 'Monitor error' : 'Browser disconnected', event.error || 'Waiting to reconnect…');
    return;
  }
  if (event.type === 'connected' || event.type === 'pages') {
    if (event.type === 'connected') {
      if (state.sessionId && event.sessionId && state.sessionId !== event.sessionId) {
        clearTarget('Connecting', 'Waiting for a screenshot…');
      }
      state.sessionId = event.sessionId;
      setStatus('Live', 'good');
      subtitle.textContent = `Session ${event.sessionId ?? 'live'}`;
    }
    if (event.pageId && event.pageId !== pageId) {
      clearTarget('Connecting', 'Loading selected tab…', { preserveCache: true });
      pageId = event.pageId;
      const next = new URL(location.href);
      next.searchParams.set('pageId', pageId);
      history.replaceState(null, '', next);
    }
    state.pages = event.pages ?? [];
    pruneMonitorPreviewCache(state.pages);
    if (!state.previewUrl) showCachedMonitorPreview();
    renderPageTabs(state.pages, event.pageId);
    if (event.pageState) updatePageState(event.pageState);
    if (event.pageId && state.viewport) resumeTarget();
    return;
  }
  if (event.type === 'page' || event.type === 'viewport') {
    if (event.type !== 'page' && !state.hasTarget) return;
    updatePageState(event);
    if (event.type === 'page' && state.viewport) resumeTarget();
    return;
  }
  if (event.type === 'click') {
    if (!state.hasTarget) return;
    state.lastClick = event;
    placeClickMarker(event);
    return;
  }
}

function setTargetControls(enabled) {
  for (const button of [refreshButton, backButton, forwardButton, reloadButton]) button.disabled = !enabled;
  imageWrap.setAttribute('aria-disabled', String(!enabled));
  imageWrap.tabIndex = enabled ? 0 : -1;
}

function resumeTarget() {
  if (state.hasTarget) return;
  state.hasTarget = true;
  setStatus('Live', 'good');
  setTargetControls(true);
  void refreshScreenshot();
}

function clearTarget(label, message, { preserveCache = false } = {}) {
  state.hasTarget = false;
  state.targetGeneration += 1;
  state.captureController?.abort();
  state.captureController = undefined;
  state.refreshing = false;
  state.actionController?.abort();
  clearTimeout(state.refreshTimer);
  state.refreshTimer = undefined;
  clearTimeout(state.inputErrorTimer);
  state.inputErrorUntil = 0;
  state.inputErrorTimer = undefined;
  cancelPendingPointerMove();
  state.actionQueue.length = 0;
  state.pressedKeys.clear();
  state.suppressedKeyUps.clear();
  if (state.activePointer) imageWrap.releasePointerCapture?.(state.activePointer.pointerId);
  state.activePointer = undefined;
  state.viewport = undefined;
  state.lastClick = undefined;
  if (!preserveCache) {
    clearMonitorPreviewCache();
    state.pages = [];
  }
  state.previewUrl = undefined;
  image.removeAttribute('src');
  image.classList.add('hidden');
  clickMarker.classList.remove('visible');
  pageTabs.replaceChildren();
  state.pageTabOffset = 0;
  state.pageTabSelectedId = undefined;
  pageSummary.textContent = 'No available target';
  navTargetUrl.textContent = 'No target page';
  navTargetUrl.title = message;
  navTargetUrl.removeAttribute('href');
  for (const name of ['viewport', 'scroll', 'click', 'update']) {
    document.querySelector(`#${name}-meta`).textContent = `${name === 'update' ? 'Updated' : name[0].toUpperCase() + name.slice(1)} —`;
  }
  inputMeta.textContent = 'Input unavailable';
  empty.textContent = message;
  empty.classList.remove('hidden');
  setStatus(label, 'bad');
  setTargetControls(false);
}

function updatePageState(event) {
  if (event.viewport) state.viewport = event.viewport;
  if (event.url !== undefined) {
    const meta = `${event.title || '(untitled)'} · ${event.url}`;
    navTargetUrl.textContent = event.url;
    navTargetUrl.title = meta;
    navTargetUrl.href = event.url;
  }
  const viewport = event.viewport ?? state.viewport;
  if (viewport) document.querySelector('#viewport-meta').textContent = `Viewport ${viewport.width} × ${viewport.height}`;
  if (event.scroll) document.querySelector('#scroll-meta').textContent = `Scroll ${Math.round(event.scroll.x)}, ${Math.round(event.scroll.y)}`;
  if (event.capturedAt) document.querySelector('#update-meta').textContent = `Updated ${new Date(event.capturedAt).toLocaleTimeString()}`;
  placeClickMarker(state.lastClick);
}

async function decodedObjectUrl(blob) {
  const url = URL.createObjectURL(blob);
  const candidate = new Image();
  candidate.src = url;
  try {
    await candidate.decode();
    return { url, width: candidate.naturalWidth, height: candidate.naturalHeight };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

async function refreshScreenshot() {
  if (!state.hasTarget || state.refreshing) return;
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = undefined;
  }
  state.refreshing = true;
  const generation = state.targetGeneration;
  const capturedPageId = pageId;
  const controller = new AbortController();
  state.captureController = controller;
  refreshButton.disabled = true;
  try {
    const response = await fetch(monitorUrl('preview'), { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`Screenshot capture failed: ${response.status}`);
    const next = await decodedObjectUrl(await response.blob());
    if (!state.hasTarget || generation !== state.targetGeneration || capturedPageId !== pageId) {
      URL.revokeObjectURL(next.url);
      return;
    }
    const previous = state.previewCache.get(capturedPageId);
    state.previewCache.delete(capturedPageId);
    state.previewCache.set(capturedPageId, { ...next, pageUrl: state.pages.find((page) => page.id === capturedPageId)?.url });
    displayMonitorPreview(next);
    if (previous) URL.revokeObjectURL(previous.url);
    // Full-size monitor screenshots have a smaller cache than thumbnails.
    while (state.previewCache.size > 6) {
      const oldestId = state.previewCache.keys().next().value;
      URL.revokeObjectURL(state.previewCache.get(oldestId).url);
      state.previewCache.delete(oldestId);
    }
    document.querySelector('#update-meta').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch {
    if (state.hasTarget && generation === state.targetGeneration && !state.previewUrl) {
      empty.textContent = 'Screenshot unavailable; retrying…';
      empty.classList.remove('hidden');
    }
  } finally {
    if (generation === state.targetGeneration && state.captureController === controller) {
      state.captureController = undefined;
      state.refreshing = false;
      refreshButton.disabled = !state.hasTarget;
      if (state.hasTarget) state.refreshTimer = setTimeout(() => void refreshScreenshot(), SCREENSHOT_INTERVAL_MS);
    }
  }
}

function renderPageTabs(pages, selectedPageId) {
  pageTabs.replaceChildren();
  const selectedPage = pages.find((page) => page.id === selectedPageId);
  const visibleCount = 3;
  const maxOffset = Math.max(0, pages.length - visibleCount);
  if (state.pageTabSelectedId !== selectedPageId) {
    const selectedIndex = pages.findIndex((page) => page.id === selectedPageId);
    state.pageTabOffset = Math.max(0, selectedIndex - visibleCount + 1);
    state.pageTabSelectedId = selectedPageId;
  }
  state.pageTabOffset = Math.min(state.pageTabOffset, maxOffset);
  const numbers = document.createElement('div');
  numbers.className = 'page-tab-numbers';
  const previous = createArrow('Previous tabs', '‹', -1);
  const next = createArrow('Next tabs', '›', 1);
  if (maxOffset) pageTabs.append(previous, numbers, next);
  else if (pages.length) pageTabs.append(numbers);

  function createArrow(label, text, direction) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'page-tab-arrow';
    button.textContent = text;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      state.pageTabOffset = Math.max(0, Math.min(state.pageTabOffset + direction, maxOffset));
      renderNumbers();
    });
    return button;
  }

  function renderNumbers() {
    previous.disabled = state.pageTabOffset === 0;
    next.disabled = state.pageTabOffset === maxOffset;
    numbers.replaceChildren();
    for (let index = state.pageTabOffset; index < Math.min(state.pageTabOffset + visibleCount, pages.length); index += 1) {
      const page = pages[index];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `page-tab${page.id === selectedPageId ? ' selected' : ''}${page.lease ? ' leased' : ''}`;
      button.textContent = String(index + 1);
      button.title = `${page.title || '(untitled)'}\n${page.url || ''}${page.lease ? `\nLeased by ${page.lease.owner}` : ''}`;
      button.setAttribute('aria-label', `Monitor tab ${index + 1}: ${page.title || page.url || '(untitled)'}`);
      button.setAttribute('aria-pressed', String(page.id === selectedPageId));
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        if (page.id !== selectedPageId) selectPage(page.id);
      });
      numbers.append(button);
    }
  }
  renderNumbers();
  pageSummary.textContent = selectedPage
    ? `${selectedPage.title || '(untitled)'} · ${selectedPage.lease ? `Leased by ${selectedPage.lease.owner}` : 'Available'}`
    : pages.length ? 'Selected tab is no longer available' : 'No open tabs';
}

function selectPage(nextPageId, { updateHistory = true } = {}) {
  if (nextPageId === pageId) return;
  if (updateHistory && !state.pages.some((page) => page.id === nextPageId)) return;
  // Release held input against the old target before clearing its queue.
  const releases = [...state.pressedKeys].map((key) => ({ action: 'keyboard', type: 'up', key }));
  if (state.activePointer) releases.push({ action: 'pointer', type: 'up', ...state.activePointer.point, button: state.activePointer.button });
  for (const payload of releases) {
    void fetch(monitorUrl('action'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload), keepalive: true,
    }).catch(() => {});
  }
  eventSource?.close();
  eventSource = undefined;
  clearTarget('Connecting', 'Loading selected tab…', { preserveCache: true });
  pageId = nextPageId;
  const next = new URL(location.href);
  if (pageId) next.searchParams.set('pageId', pageId);
  else next.searchParams.delete('pageId');
  if (updateHistory) history.pushState(null, '', next);
  renderPageTabs(state.pages, pageId);
  const selected = state.pages.find((page) => page.id === pageId);
  if (selected) updatePageState({ url: selected.url, title: selected.title });
  showCachedMonitorPreview();
  connectMonitorStream();
}

function placeClickMarker(click) {
  const viewport = click?.viewport ?? state.viewport;
  if (!click || !viewport?.width || !viewport?.height || !image.complete || !image.src) return;
  const imageBox = image.getBoundingClientRect();
  const wrapBox = imageWrap.getBoundingClientRect();
  const scale = Math.min(imageBox.width / viewport.width, imageBox.height / viewport.height);
  const renderedWidth = viewport.width * scale;
  const renderedHeight = viewport.height * scale;
  const left = imageBox.left + (imageBox.width - renderedWidth) / 2;
  const top = imageBox.top + (imageBox.height - renderedHeight) / 2;
  clickMarker.style.left = `${left - wrapBox.left + click.x * scale}px`;
  clickMarker.style.top = `${top - wrapBox.top + click.y * scale}px`;
  clickMarker.classList.remove('visible');
  void clickMarker.offsetWidth;
  clickMarker.classList.add('visible');
  document.querySelector('#click-meta').textContent = `Click ${Math.round(click.x)}, ${Math.round(click.y)}`;
}

function handlePointerMove(event) {
  const dragging = state.activePointer?.pointerId === event.pointerId;
  const point = pointerPosition(event, { clamp: dragging });
  if (!point) return;
  if (dragging) state.activePointer.point = point;
  state.pendingPointerMove = point;
  if (state.pointerMoveFrame) return;
  state.pointerMoveFrame = requestAnimationFrame(() => {
    state.pointerMoveFrame = undefined;
    const pending = state.pendingPointerMove;
    state.pendingPointerMove = undefined;
    if (pending) void sendAction({ action: 'pointer', type: 'move', ...pending });
  });
}

function handlePointerDown(event) {
  const point = pointerPosition(event);
  const button = BUTTON_NAMES[event.button];
  if (!point || !button) return;
  event.preventDefault();
  imageWrap.focus({ preventScroll: true });
  imageWrap.setPointerCapture?.(event.pointerId);
  cancelPendingPointerMove();
  state.activePointer = { pointerId: event.pointerId, button, point };
  void sendAction({ action: 'pointer', type: 'down', ...point, button });
}

function handlePointerUp(event) {
  const dragging = state.activePointer?.pointerId === event.pointerId;
  const point = pointerPosition(event, { clamp: dragging }) ?? state.activePointer?.point;
  const button = BUTTON_NAMES[event.button] ?? state.activePointer?.button;
  if (!point || !button) return;
  event.preventDefault();
  cancelPendingPointerMove();
  void sendAction({ action: 'pointer', type: 'up', ...point, button });
  imageWrap.releasePointerCapture?.(event.pointerId);
  state.activePointer = undefined;
}

function handlePointerCancel(event) {
  if (!state.activePointer) return;
  cancelPendingPointerMove();
  void sendAction({
    action: 'pointer',
    type: 'up',
    ...state.activePointer.point,
    button: state.activePointer.button,
  });
  imageWrap.releasePointerCapture?.(event.pointerId);
  state.activePointer = undefined;
}

function handleWheel(event) {
  const point = pointerPosition(event);
  if (!point) return;
  event.preventDefault();
  const multiplier = event.deltaMode === 1
    ? WHEEL_LINE_HEIGHT_PX
    : event.deltaMode === 2 ? state.viewport.height : 1;
  void sendAction({
    action: 'pointer',
    type: 'wheel',
    ...point,
    deltaX: event.deltaX * multiplier,
    deltaY: event.deltaY * multiplier,
  });
}

function handleKeyDown(event) {
  if (event.isComposing || event.key === 'Process' || event.key === 'Dead') return;
  const key = normalizeKey(event.key);
  if (isPasteShortcut(event)) {
    state.suppressedKeyUps.add(event.code || key);
    return;
  }
  event.preventDefault();
  state.pressedKeys.add(key);
  void sendAction({ action: 'keyboard', type: 'down', key });
}

function handleKeyUp(event) {
  if (event.isComposing || event.key === 'Process' || event.key === 'Dead') return;
  const key = normalizeKey(event.key);
  if (state.suppressedKeyUps.delete(event.code || key)) return;
  event.preventDefault();
  state.pressedKeys.delete(key);
  void sendAction({ action: 'keyboard', type: 'up', key });
}

function handlePaste(event) {
  const text = event.clipboardData?.getData('text/plain');
  if (text === undefined) return;
  event.preventDefault();
  void sendAction({ action: 'keyboard', type: 'insertText', text });
}

function releasePressedKeys() {
  for (const key of state.pressedKeys) {
    void sendAction({ action: 'keyboard', type: 'up', key });
  }
  state.pressedKeys.clear();
  state.suppressedKeyUps.clear();
}

function isPasteShortcut(event) {
  return (event.key.toLowerCase() === 'v' && (event.metaKey || event.ctrlKey))
    || (event.key === 'Insert' && event.shiftKey);
}

function normalizeKey(key) {
  if (key === ' ') return 'Space';
  if (key === 'Esc') return 'Escape';
  if (key === 'OS') return 'Meta';
  return key;
}

function pointerPosition(event, { clamp = false } = {}) {
  const viewport = state.viewport;
  if (!viewport?.width || !viewport?.height || !image.complete || !image.src) return undefined;
  const imageBox = image.getBoundingClientRect();
  const scale = Math.min(imageBox.width / viewport.width, imageBox.height / viewport.height);
  const renderedWidth = viewport.width * scale;
  const renderedHeight = viewport.height * scale;
  const left = imageBox.left + (imageBox.width - renderedWidth) / 2;
  const top = imageBox.top + (imageBox.height - renderedHeight) / 2;
  if (!clamp && (event.clientX < left || event.clientX > left + renderedWidth || event.clientY < top || event.clientY > top + renderedHeight)) {
    return undefined;
  }
  return {
    x: Math.min(viewport.width - 1, Math.max(0, (event.clientX - left) / scale)),
    y: Math.min(viewport.height - 1, Math.max(0, (event.clientY - top) / scale)),
  };
}

function cancelPendingPointerMove() {
  if (state.pointerMoveFrame) cancelAnimationFrame(state.pointerMoveFrame);
  state.pointerMoveFrame = undefined;
  state.pendingPointerMove = undefined;
}

function sendAction(payload) {
  if (!state.hasTarget) return;
  const queued = state.actionQueue.at(-1);
  if (isPointerMove(payload) && isPointerMove(queued)) {
    queued.x = payload.x;
    queued.y = payload.y;
  } else {
    state.actionQueue.push(payload);
  }
  void drainActionQueue();
}

async function drainActionQueue() {
  if (state.actionSending) return;
  state.actionSending = true;
  try {
    while (state.actionQueue.length) {
      const payload = state.actionQueue.shift();
      const generation = state.targetGeneration;
      const controller = new AbortController();
      state.actionController = controller;
      showInputProgress('Sending input…');
      try {
        const response = await fetch(monitorUrl('action'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result.ok === false) throw new Error(result.error || `Input failed: ${response.status}`);
        if (generation === state.targetGeneration) showInputProgress('Input active');
      } catch (error) {
        if (generation === state.targetGeneration) showInputError(error);
      } finally {
        if (state.actionController === controller) state.actionController = undefined;
      }
    }
  } finally {
    state.actionSending = false;
  }
}

function isPointerMove(payload) {
  return payload?.action === 'pointer' && payload.type === 'move';
}

function showInputProgress(label) {
  if (!state.hasTarget) return;
  if (Date.now() < state.inputErrorUntil) return;
  inputMeta.textContent = label;
}

function showInputError(error) {
  if (!state.hasTarget) return;
  state.inputErrorUntil = Date.now() + INPUT_ERROR_VISIBILITY_MS;
  inputMeta.textContent = `Input error: ${error.message}`;
  if (state.inputErrorTimer) clearTimeout(state.inputErrorTimer);
  state.inputErrorTimer = setTimeout(() => {
    state.inputErrorTimer = undefined;
    if (Date.now() >= state.inputErrorUntil) inputMeta.textContent = 'Input ready';
  }, INPUT_ERROR_VISIBILITY_MS);
}

function setStatus(label, tone) {
  status.textContent = label;
  status.className = `status-pill ${tone}`;
}
