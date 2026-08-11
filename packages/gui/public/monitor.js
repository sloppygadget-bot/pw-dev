const browserId = decodeURIComponent(location.pathname.split('/')[2] || '');
const eventSource = new EventSource(`/api/monitor/${encodeURIComponent(browserId)}/events`);
const frame = document.querySelector('#mirror-frame');
const empty = document.querySelector('#mirror-empty');
const clickMarker = document.querySelector('#mirror-click-marker');
const status = document.querySelector('#monitor-status');
const title = document.querySelector('#monitor-title');
const subtitle = document.querySelector('#monitor-subtitle');
const pageMeta = document.querySelector('#page-meta');
const search = document.querySelector('#dom-search');
const activity = document.querySelector('#activity-list');
const selectedEmpty = document.querySelector('#selected-empty');
const selectedDetails = document.querySelector('#selected-details');
const selectedLabel = document.querySelector('#selected-label');
const selectedHtml = document.querySelector('#selected-html');
const sidebar = document.querySelector('#monitor-sidebar');
const toggleSidebar = document.querySelector('#toggle-sidebar');
const closeSidebar = document.querySelector('#close-sidebar');
const navTargetUrl = document.querySelector('#nav-target-url');
const state = {
  snapshot: undefined,
  selected: undefined,
  styles: [],
  pendingPatches: [],
  patchTimer: undefined,
  viewportFrame: undefined,
  pendingViewport: undefined,
  scrollTimer: undefined,
  scrolling: false,
};

title.textContent = `DOM monitor — ${browserId}`;
document.querySelector('#state-browser').textContent = browserId || '—';
setSidebarOpen(sidebar.classList.contains('open'));

eventSource.addEventListener('message', (event) => {
  try {
    handleEvent(JSON.parse(event.data));
  } catch (error) {
    addActivity(`Invalid monitor event: ${error.message}`);
  }
});
eventSource.onerror = () => {
  setStatus('Disconnected', 'bad');
  addActivity('Monitor stream disconnected; retrying…');
};
document.querySelector('#clear-activity').addEventListener('click', () => activity.replaceChildren());
document.querySelector('#refresh-mirror').addEventListener('click', () => location.reload());
toggleSidebar.addEventListener('click', () => setSidebarOpen(!sidebar.classList.contains('open')));
closeSidebar.addEventListener('click', () => setSidebarOpen(false));
search.addEventListener('input', () => markSearch(search.value));
document.querySelector('#highlight-element').addEventListener('click', () => sendSelectedAction('highlight'));
document.querySelector('#click-element').addEventListener('click', () => sendSelectedAction('click'));
document.querySelector('#focus-element').addEventListener('click', () => sendSelectedAction('focus'));

function handleEvent(event) {
  if (event.type === 'connected') {
    setStatus('Live', 'good');
    subtitle.textContent = `Session ${event.sessionId ?? 'live'}`;
    document.querySelector('#state-session').textContent = event.sessionId ?? '—';
    addActivity('Attached to the live browser session.');
    return;
  }
  if (event.type === 'snapshot') {
    state.snapshot = event;
    state.styles = event.styles ?? [];
    renderSnapshot(event);
    addActivity(`DOM snapshot ${event.url}`);
    return;
  }
  if (event.type === 'patches') {
    const merged = new Map(state.pendingPatches.map(patch => [JSON.stringify(patch.path), patch]));
    for (const patch of event.patches ?? []) merged.set(JSON.stringify(patch.path), patch);
    state.pendingPatches = [...merged.values()];
    schedulePatchFlush();
    return;
  }
  if (event.type === 'styles') {
    state.styles = event.styles ?? [];
    updateStyleCount();
    return;
  }
  if (event.type === 'viewport') {
    state.pendingViewport = event;
    if (state.viewportFrame === undefined) {
      state.viewportFrame = requestAnimationFrame(() => {
        state.viewportFrame = undefined;
        const viewport = state.pendingViewport;
        state.pendingViewport = undefined;
        if (viewport) updateViewport(viewport);
      });
    }
    return;
  }
  if (event.type === 'click') {
    showClickMarker(event.x, event.y, event.viewport);
    addActivity(`Real click at ${Math.round(event.x)}, ${Math.round(event.y)}`);
    return;
  }
  if (event.type === 'disconnected') {
    setStatus('Browser disconnected', 'bad');
    addActivity(event.reason ?? 'Browser disconnected.');
    return;
  }
  if (event.type === 'error') addActivity(`Monitor error: ${event.error}`);
}

function renderSnapshot(snapshot) {
  const documentHtml = sanitizeHtml(snapshot.html, snapshot.styles, snapshot.url);
  frame.addEventListener('load', () => {
    empty.classList.add('hidden');
    attachFrameEvents();
    updateTimestamp(snapshot.capturedAt);
    updateViewport(snapshot);
    markSearch(search.value);
  }, { once: true });
  empty.textContent = 'Rendering DOM snapshot…';
  empty.classList.remove('hidden');
  frame.srcdoc = documentHtml;
  pageMeta.textContent = `${snapshot.title || '(untitled)'} · ${snapshot.url}`;
  document.querySelector('#state-url').textContent = snapshot.url;
  document.querySelector('#state-title').textContent = snapshot.title || '(untitled)';
  updateTargetUrl(snapshot.url);
  updateStyleCount();
}

function updateTargetUrl(url) {
  const value = url || '—';
  navTargetUrl.textContent = value;
  navTargetUrl.title = value;
  navTargetUrl.href = url || '#';
}

function setSidebarOpen(open) {
  sidebar.classList.toggle('open', open);
  toggleSidebar.setAttribute('aria-expanded', String(open));
  toggleSidebar.dataset.open = String(open);
  toggleSidebar.setAttribute('aria-label', open ? 'Hide inspector' : 'Show inspector');
  toggleSidebar.title = open ? 'Hide inspector' : 'Show inspector';
}

function sanitizeHtml(html, styles, baseUrl) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html || '<html><head></head><body></body></html>', 'text/html');
  for (const node of doc.querySelectorAll('script, noscript, base')) node.remove();
  // A snapshot only contains the outer document. Replaying an iframe's live
  // URL would load an unrelated third-party document inside the mirror (and
  // can make it visually diverge from the page being inspected). Keep the
  // frame's dimensions and styling, but make its contents inert.
  for (const iframe of doc.querySelectorAll('iframe')) {
    iframe.removeAttribute('srcdoc');
    iframe.setAttribute('src', 'about:blank');
  }
  for (const element of doc.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
    }
  }
  const base = doc.createElement('base');
  base.href = baseUrl || location.href;
  doc.head.prepend(base);
  for (const sheet of styles ?? []) {
    if (sheet.text) {
      const style = doc.createElement('style');
      style.textContent = sheet.text;
      doc.head.append(style);
    } else if (sheet.href) {
      const link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.href = sheet.href;
      doc.head.append(link);
    }
  }
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

function attachFrameEvents() {
  const frameDocument = frame.contentDocument;
  if (!frameDocument || frameDocument.documentElement?.dataset.pwdevAttached === 'true') return;
  frameDocument.documentElement.dataset.pwdevAttached = 'true';
  frameDocument.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showClickMarker(event.clientX, event.clientY);
    selectElement(event.target);
  }, true);
  frameDocument.addEventListener('mouseover', (event) => {
    if (event.target?.nodeType === 1) event.target.style.outline = '1px dashed #4c83b6';
  }, true);
  frameDocument.addEventListener('mouseout', (event) => {
    if (event.target?.nodeType === 1 && event.target !== state.selected) event.target.style.outline = '';
  }, true);
  annotatePaths();
}

function annotatePaths() {
  const frameDocument = frame.contentDocument;
  if (!frameDocument) return;
  for (const element of frameDocument.querySelectorAll('*')) {
    element.dataset.pwdevPath = JSON.stringify(pathOf(element));
  }
}

function pathOf(node) {
  const path = [];
  while (node && node !== frame.contentDocument.documentElement) {
    path.unshift([...node.parentNode.childNodes].indexOf(node));
    node = node.parentNode;
  }
  return path;
}

function nodeAtPath(path) {
  let node = frame.contentDocument?.documentElement;
  for (const index of path ?? []) node = node?.childNodes?.[index];
  return node?.nodeType === 1 ? node : undefined;
}

function applyPatch(patch) {
  const node = nodeAtPath(patch.path);
  if (!node) return;
  if (patch.mode === 'innerHTML') {
    node.innerHTML = patch.html;
  } else {
    const template = frame.contentDocument.createElement('template');
    template.innerHTML = patch.html;
    const replacement = template.content.firstElementChild;
    if (!replacement) return;
    node.replaceWith(replacement);
  }
  annotatePaths();
}

function schedulePatchFlush() {
  if (state.patchTimer !== undefined) clearTimeout(state.patchTimer);
  if (state.scrolling) {
    state.patchTimer = undefined;
    return;
  }
  state.patchTimer = setTimeout(flushPatches, 600);
}

function flushPatches() {
  state.patchTimer = undefined;
  if (state.scrolling) return;
  const patches = state.pendingPatches.splice(0);
  if (!patches.length || !frame.contentDocument) return;
  const scroll = {
    x: frame.contentWindow?.scrollX ?? 0,
    y: frame.contentWindow?.scrollY ?? 0,
  };
  for (const patch of patches) applyPatch(patch);
  markSearch(search.value);
  frame.contentWindow?.scrollTo(scroll.x, scroll.y);
  updateTimestamp();
  addActivity(`${patches.length} DOM patch${patches.length === 1 ? '' : 'es'}`);
}

function selectElement(element) {
  if (element?.nodeType !== 1) return;
  state.selected = element;
  selectedEmpty.classList.add('hidden');
  selectedDetails.classList.remove('hidden');
  selectedLabel.textContent = `${element.tagName.toLowerCase()} · ${JSON.stringify(pathOf(element))}`;
  selectedHtml.textContent = element.outerHTML;
  for (const item of frame.contentDocument.querySelectorAll('[data-pwdev-selected]')) item.removeAttribute('data-pwdev-selected');
  element.setAttribute('data-pwdev-selected', 'true');
  addActivity(`Selected <${element.tagName.toLowerCase()}>`);
}

function showClickMarker(x, y, sourceViewport) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !frame.contentDocument) return;
  const frameRect = frame.getBoundingClientRect();
  const wrapRect = document.querySelector('#mirror-frame-wrap').getBoundingClientRect();
  const mirrorWidth = frame.contentWindow?.innerWidth || frame.clientWidth;
  const mirrorHeight = frame.contentWindow?.innerHeight || frame.clientHeight;
  const sourceWidth = sourceViewport?.width || mirrorWidth;
  const sourceHeight = sourceViewport?.height || mirrorHeight;
  const mirrorX = sourceViewport ? x * mirrorWidth / sourceWidth : x;
  const mirrorY = sourceViewport ? y * mirrorHeight / sourceHeight : y;
  clickMarker.style.left = `${frameRect.left - wrapRect.left + mirrorX}px`;
  clickMarker.style.top = `${frameRect.top - wrapRect.top + mirrorY}px`;
  clickMarker.classList.remove('visible');
  void clickMarker.offsetWidth;
  clickMarker.classList.add('visible');
  document.querySelector('#click-meta').textContent = `Click ${Math.round(x)}, ${Math.round(y)}`;
}

async function sendSelectedAction(action) {
  if (!state.selected) return;
  const path = pathOf(state.selected);
  try {
    const response = await fetch(`/api/monitor/${encodeURIComponent(browserId)}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, path }),
    });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) throw new Error(payload.error || 'Monitor action failed');
    addActivity(`${action} sent to ${payload.result?.tagName ?? 'element'}`);
  } catch (error) {
    addActivity(`Action failed: ${error.message}`);
  }
}

function markSearch(query) {
  const frameDocument = frame.contentDocument;
  if (!frameDocument) return;
  for (const element of frameDocument.querySelectorAll('[data-pwdev-search]')) {
    element.removeAttribute('data-pwdev-search');
  }
  if (!query?.trim()) return;
  let matches = [];
  try { matches = [...frameDocument.querySelectorAll(query)]; } catch {
    const lower = query.toLowerCase();
    matches = [...frameDocument.querySelectorAll('*')].filter((element) => element.textContent.toLowerCase().includes(lower));
  }
  for (const element of matches.slice(0, 100)) element.setAttribute('data-pwdev-search', 'true');
  addActivity(`${matches.length} mirror match${matches.length === 1 ? '' : 'es'}`);
}

function updateViewport(event) {
  state.scrolling = true;
  clearTimeout(state.scrollTimer);
  state.scrollTimer = setTimeout(() => {
    state.scrolling = false;
    schedulePatchFlush();
  }, 800);
  const viewport = event.viewport ?? {};
  const scroll = event.scroll ?? {};
  document.querySelector('#viewport-meta').textContent = `Viewport ${viewport.width ?? '—'}×${viewport.height ?? '—'} @${viewport.devicePixelRatio ?? '—'}x`;
  document.querySelector('#scroll-meta').textContent = `Scroll ${Math.round(scroll.x ?? 0)}, ${Math.round(scroll.y ?? 0)}`;
  if (frame.contentWindow && Number.isFinite(scroll.x) && Number.isFinite(scroll.y)) frame.contentWindow.scrollTo(scroll.x, scroll.y);
}

function updateStyleCount() {
  document.querySelector('#state-styles').textContent = `${state.styles.length} stylesheet${state.styles.length === 1 ? '' : 's'}`;
}

function updateTimestamp(value = new Date().toISOString()) {
  document.querySelector('#update-meta').textContent = `Updated ${new Date(value).toLocaleTimeString()}`;
}

function setStatus(label, tone) {
  status.textContent = label;
  status.className = `status-pill ${tone}`;
}

function addActivity(message) {
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString()} — ${message}`;
  activity.prepend(item);
  while (activity.children.length > 80) activity.lastElementChild.remove();
}
