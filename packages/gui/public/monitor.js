const browserId = decodeURIComponent(location.pathname.split('/')[2] || '');
let pageId = new URLSearchParams(location.search).get('pageId');
const monitorUrl = (suffix) => `/api/monitor/${encodeURIComponent(browserId)}/${suffix}${pageId ? `?pageId=${encodeURIComponent(pageId)}` : ''}`;
const eventSource = new EventSource(monitorUrl('events'));
const image = document.querySelector('#mirror-image');
const imageWrap = document.querySelector('#mirror-frame-wrap');
const empty = document.querySelector('#mirror-empty');
const clickMarker = document.querySelector('#mirror-click-marker');
const status = document.querySelector('#monitor-status');
const title = document.querySelector('#monitor-title');
const subtitle = document.querySelector('#monitor-subtitle');
const pageMeta = document.querySelector('#page-meta');
const navTargetUrl = document.querySelector('#nav-target-url');
const refreshButton = document.querySelector('#refresh-screenshot');
const pageDots = document.querySelector('#page-dots');
const pageSummary = document.querySelector('#page-summary');
const SCREENSHOT_INTERVAL_MS = 1_000;
const state = {
  previewUrl: undefined,
  refreshTimer: undefined,
  refreshing: false,
  viewport: undefined,
  lastClick: undefined,
};

title.textContent = `Screenshot monitor — ${browserId}`;

eventSource.addEventListener('message', (event) => {
  try {
    handleEvent(JSON.parse(event.data));
  } catch {
    setStatus('Monitor error', 'bad');
  }
});
eventSource.onerror = () => setStatus('Disconnected', 'bad');
refreshButton.addEventListener('click', () => void refreshScreenshot());
image.addEventListener('load', () => {
  empty.classList.add('hidden');
  placeClickMarker(state.lastClick);
});
window.addEventListener('resize', () => placeClickMarker(state.lastClick));
window.addEventListener('beforeunload', () => {
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
});

void refreshScreenshot();

function handleEvent(event) {
  if (event.type === 'connected' || event.type === 'pages') {
    if (event.type === 'connected') {
      setStatus('Live', 'good');
      subtitle.textContent = `Session ${event.sessionId ?? 'live'}`;
    }
    if (event.pageId && event.pageId !== pageId) {
      pageId = event.pageId;
      const next = new URL(location.href);
      next.searchParams.set('pageId', pageId);
      history.replaceState(null, '', next);
    }
    renderPageDots(event.pages ?? [], event.pageId);
    return;
  }
  if (event.type === 'page' || event.type === 'viewport') {
    updatePageState(event);
    return;
  }
  if (event.type === 'click') {
    state.lastClick = event;
    placeClickMarker(event);
    return;
  }
  if (event.type === 'disconnected') setStatus('Browser disconnected', 'bad');
}

function updatePageState(event) {
  if (event.viewport) state.viewport = event.viewport;
  if (event.url !== undefined) {
    const meta = `${event.title || '(untitled)'} · ${event.url}`;
    pageMeta.textContent = meta;
    pageMeta.title = meta;
    navTargetUrl.textContent = event.url;
    navTargetUrl.title = event.url;
    navTargetUrl.href = event.url;
  }
  const viewport = event.viewport ?? state.viewport;
  if (viewport) document.querySelector('#viewport-meta').textContent = `Viewport ${viewport.width} × ${viewport.height}`;
  if (event.scroll) document.querySelector('#scroll-meta').textContent = `Scroll ${Math.round(event.scroll.x)}, ${Math.round(event.scroll.y)}`;
  if (event.capturedAt) document.querySelector('#update-meta').textContent = `Updated ${new Date(event.capturedAt).toLocaleTimeString()}`;
  placeClickMarker(state.lastClick);
}

async function refreshScreenshot() {
  if (state.refreshing) return;
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = undefined;
  }
  state.refreshing = true;
  refreshButton.disabled = true;
  try {
    const response = await fetch(monitorUrl('preview'), { cache: 'no-store' });
    if (!response.ok) throw new Error(`Screenshot capture failed: ${response.status}`);
    const nextUrl = URL.createObjectURL(await response.blob());
    const previousUrl = state.previewUrl;
    state.previewUrl = nextUrl;
    image.src = nextUrl;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    document.querySelector('#update-meta').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch {
    if (!state.previewUrl) {
      empty.textContent = 'Screenshot unavailable; retrying…';
      empty.classList.remove('hidden');
    }
  } finally {
    state.refreshing = false;
    refreshButton.disabled = false;
    state.refreshTimer = setTimeout(() => void refreshScreenshot(), SCREENSHOT_INTERVAL_MS);
  }
}

function renderPageDots(pages, selectedPageId) {
  pageDots.replaceChildren();
  const selectedPage = pages.find((page) => page.id === selectedPageId);
  const visiblePages = pages.slice(0, 3);
  if (selectedPage && !visiblePages.includes(selectedPage) && visiblePages.length === 3) visiblePages[2] = selectedPage;
  const visibleIds = new Set(visiblePages.map((page) => page.id));
  for (const page of visiblePages) {
    const index = pages.indexOf(page);
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = `page-dot${page.id === selectedPageId ? ' selected' : ''}${page.lease ? ' leased' : ''}`;
    dot.title = `${page.title || '(untitled)'} · ${page.url}${page.lease ? ` · leased by ${page.lease.owner}` : ' · available'}`;
    dot.setAttribute('aria-label', `Monitor tab ${index + 1}: ${page.title || page.url}`);
    dot.addEventListener('click', () => selectPage(page.id));
    pageDots.append(dot);
  }
  const hiddenPages = pages.filter((page) => !visibleIds.has(page.id));
  if (hiddenPages.length) {
    const picker = document.createElement('select');
    picker.className = 'page-picker';
    picker.setAttribute('aria-label', 'Choose another session tab');
    picker.append(new Option(`+${hiddenPages.length} tabs`, ''));
    for (const page of hiddenPages) picker.append(new Option(`${page.lease ? '🔒 ' : ''}${page.title || page.url || '(untitled)'}`, page.id));
    picker.addEventListener('change', () => {
      if (picker.value) selectPage(picker.value);
    });
    pageDots.append(picker);
  }
  pageSummary.textContent = selectedPage
    ? `${selectedPage.title || '(untitled)'} · ${selectedPage.lease ? `Leased by ${selectedPage.lease.owner}` : 'Available'}`
    : pages.length ? 'Selected tab is no longer available' : 'No open tabs';
}

function selectPage(nextPageId) {
  const next = new URL(location.href);
  next.searchParams.set('pageId', nextPageId);
  location.assign(next);
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

function setStatus(label, tone) {
  status.textContent = label;
  status.className = `status-pill ${tone}`;
}
