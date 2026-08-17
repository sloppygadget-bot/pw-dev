const state = {
  timer: undefined,
  intervalMs: 5000,
  refreshGeneration: 0,
  pwDevUrl: '',
  currentView: 'browsers',
  last: undefined,
  browserView: 'diagram',
  previewUrls: new Map(),
  markdownModalText: '',
  editingBrowserId: undefined,
  editingBrowserConfigId: undefined,
  editingProxyId: undefined,
};

const els = {
  interval: document.querySelector('#interval'),
  refresh: document.querySelector('#refresh'),
  serverState: document.querySelector('#server-state'),
  brokerState: document.querySelector('#broker-state'),
  sessionsState: document.querySelector('#sessions-state'),
  updatedAt: document.querySelector('#updated-at'),
  browsersDiagram: document.querySelector('#browsers-diagram'),
  browsersTable: document.querySelector('#browsers-table'),
  apps: document.querySelector('#apps-list'),
  broker: document.querySelector('#broker-list'),
  browserConfigs: document.querySelector('#browser-configs-list'),
  sessions: document.querySelector('#sessions-list'),
  proxies: document.querySelector('#proxies-list'),
  newBrowser: document.querySelector('#new-browser'),
  browserEditor: document.querySelector('#browser-editor'),
  browserEditorTitle: document.querySelector('#browser-editor-title'),
  cancelBrowser: document.querySelector('#cancel-browser'),
  browserId: document.querySelector('#browser-id'),
  browserName: document.querySelector('#browser-name'),
  browserConfigId: document.querySelector('#browser-config-id'),
  browserAppId: document.querySelector('#browser-app-id'),
  browserProxyId: document.querySelector('#browser-proxy-id'),
  browserProxyIds: document.querySelector('#browser-proxy-ids'),
  browserProfile: document.querySelector('#browser-profile'),
  browserReadme: document.querySelector('#browser-readme'),
  browserEditorError: document.querySelector('#browser-editor-error'),
  newBrowserConfig: document.querySelector('#new-browser-config'),
  browserConfigEditor: document.querySelector('#browser-config-editor'),
  browserConfigEditorTitle: document.querySelector('#browser-config-editor-title'),
  cancelBrowserConfig: document.querySelector('#cancel-browser-config'),
  browserConfigIdEditor: document.querySelector('#browser-config-id-editor'),
  browserConfigName: document.querySelector('#browser-config-name'),
  browserConfigTargetUrl: document.querySelector('#browser-config-target-url'),
  browserConfigBrokerUrl: document.querySelector('#browser-config-broker-url'),
  browserConfigProfile: document.querySelector('#browser-config-profile'),
  browserConfigProxyBypassList: document.querySelector('#browser-config-proxy-bypass-list'),
  browserConfigIgnoreSslErrors: document.querySelector('#browser-config-ignore-ssl-errors'),
  browserConfigHeadless: document.querySelector('#browser-config-headless'),
  browserConfigResetProfile: document.querySelector('#browser-config-reset-profile'),
  browserConfigEditorError: document.querySelector('#browser-config-editor-error'),
  newProxy: document.querySelector('#new-proxy'),
  proxyEditor: document.querySelector('#proxy-editor'),
  proxyEditorTitle: document.querySelector('#proxy-editor-title'),
  cancelProxy: document.querySelector('#cancel-proxy'),
  proxyId: document.querySelector('#proxy-id'),
  proxyName: document.querySelector('#proxy-name'),
  proxyKind: document.querySelector('#proxy-kind'),
  proxyUrl: document.querySelector('#proxy-url'),
  proxyForwardId: document.querySelector('#proxy-forward-id'),
  proxyGuiUrl: document.querySelector('#proxy-gui-url'),
  proxyOwner: document.querySelector('#proxy-owner'),
  proxyTaskId: document.querySelector('#proxy-task-id'),
  proxyPurpose: document.querySelector('#proxy-purpose'),
  proxyLabels: document.querySelector('#proxy-labels'),
  proxyEditorError: document.querySelector('#proxy-editor-error'),
  markdownModal: document.querySelector('#markdown-modal'),
  markdownModalTitle: document.querySelector('#markdown-modal-title'),
  markdownModalSubtitle: document.querySelector('#markdown-modal-subtitle'),
  markdownModalContent: document.querySelector('#markdown-modal-content'),
  closeMarkdownModal: document.querySelector('#close-markdown-modal'),
  copyMarkdownModal: document.querySelector('#copy-markdown-modal'),
};

els.newBrowser.disabled = true;
els.newBrowserConfig.disabled = true;
els.newProxy.disabled = true;

for (const button of document.querySelectorAll('[data-browser-view]')) {
  button.addEventListener('click', () => {
    state.browserView = button.dataset.browserView;
    for (const item of document.querySelectorAll('[data-browser-view]')) {
      item.classList.toggle('active', item.dataset.browserView === state.browserView);
    }
    if (state.last) renderBrowsers(state.last.browsers);
  });
}

for (const button of document.querySelectorAll('.nav-item')) {
  button.addEventListener('click', () => showView(button.dataset.view));
}

els.refresh.addEventListener('click', () => void refresh());
els.newBrowser.addEventListener('click', () => openBrowserEditor());
els.cancelBrowser.addEventListener('click', closeBrowserEditor);
els.browserEditor.addEventListener('submit', (event) => {
  event.preventDefault();
  void saveBrowser();
});
els.newBrowserConfig.addEventListener('click', () => openBrowserConfigEditor());
els.cancelBrowserConfig.addEventListener('click', closeBrowserConfigEditor);
els.browserConfigEditor.addEventListener('submit', (event) => {
  event.preventDefault();
  void saveBrowserConfig();
});
els.newProxy.addEventListener('click', () => openProxyEditor());
els.cancelProxy.addEventListener('click', closeProxyEditor);
els.proxyEditor.addEventListener('submit', (event) => {
  event.preventDefault();
  void saveProxy();
});
els.closeMarkdownModal.addEventListener('click', closeMarkdownModal);
els.markdownModal.addEventListener('click', (event) => {
  if (event.target.matches('[data-close-markdown-modal]')) closeMarkdownModal();
});
els.copyMarkdownModal.addEventListener('click', copyMarkdownModal);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !els.markdownModal.classList.contains('hidden')) closeMarkdownModal();
});
els.interval.addEventListener('change', () => {
  state.intervalMs = Number(els.interval.value);
  schedule();
});

void init();

async function init() {
  const config = await fetchJson('/api/config');
  state.pwDevUrl = config.pwDevUrl;
  await refresh();
  els.newBrowser.disabled = false;
  els.newBrowserConfig.disabled = false;
  els.newProxy.disabled = false;
  schedule();
}

function schedule() {
  if (state.timer) clearInterval(state.timer);
  state.timer = undefined;
  if (state.intervalMs > 0) {
    state.timer = setInterval(() => void refresh(), state.intervalMs);
  }
}

function showView(view) {
  state.currentView = view;
  const navItem = document.querySelector(`.nav-item[data-view="${view}"]`);
  navItem?.closest('details.nav-group')?.setAttribute('open', '');
  for (const item of document.querySelectorAll('.nav-item')) {
    item.classList.toggle('active', item.dataset.view === view);
  }
  for (const panel of document.querySelectorAll('.view')) {
    panel.classList.toggle('active', panel.id === `view-${view}`);
  }
}

function showApp(appId) {
  showView('apps');
  focusEntityRow(els.apps, 'appId', appId, 'app-target');
}

function showProxy(proxyId) {
  showView('proxies');
  focusEntityRow(els.proxies, 'proxyId', proxyId, 'proxy-target');
}

function showBrowserConfig(browserConfigId) {
  showView('browser-configs');
  focusEntityRow(els.browserConfigs, 'browserConfigId', browserConfigId, 'browser-config-target');
}

function focusEntityRow(root, dataKey, id, targetClass) {
  const row = [...root.querySelectorAll(`[data-${dataKey.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}]`)]
    .find((item) => item.dataset[dataKey] === id);
  if (!row) return;
  for (const target of root.querySelectorAll('.entity-target')) {
    target.classList.remove('entity-target', 'app-target', 'proxy-target', 'session-target', 'browser-config-target');
  }
  row.classList.add('entity-target', targetClass);
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.focus({ preventScroll: true });
}

function showSession(sessionId) {
  showView('sessions');
  const sessionRow = [...els.sessions.querySelectorAll('[data-session-id]')]
    .find((row) => row.dataset.sessionId === sessionId);
  if (!sessionRow) return;
  for (const row of els.sessions.querySelectorAll('.session-target')) {
    row.classList.remove('session-target');
  }
  sessionRow.classList.add('session-target');
  sessionRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
  sessionRow.focus({ preventScroll: true });
}

function showNetwork(networkId) {
  showView('networks');
  const networkCard = [...els.networks.querySelectorAll('[data-network-id]')]
    .find((card) => card.dataset.networkId === networkId);
  if (!networkCard) return;
  networkCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  networkCard.focus({ preventScroll: true });
}

async function refresh() {
  els.refresh.disabled = true;
  const generation = ++state.refreshGeneration;
  try {
    const snapshot = normalizeSnapshot(await fetchJson('/api/snapshot'));
    if (generation !== state.refreshGeneration) return;
    state.last = snapshot;
    await render(snapshot);
  } finally {
    els.refresh.disabled = false;
  }
}

function normalizeSnapshot(raw) {
  const status = raw.server.status;
  const apps = raw.server.apps;
  const serverBrowserConfigs = raw.server.browserConfigs;
  const serverSessions = raw.server.sessions;
  const proxies = raw.server.proxies;
  const serverNetworks = raw.server.networks;
  const brokerStatusFetch = raw.broker.status;
  const brokerNetworks = raw.broker.networks;
  const brokerForwards = raw.broker.proxyForwards;
  const proxyStatus = raw.proxyManager.status;
  const proxyStatuses = raw.server.proxyStatuses ?? [];
  const brokerEntries = normalizeBrokerEntries(raw);

  const serverOk = status.ok && status.body?.ok;
  const appList = apps.ok && apps.body?.apps
    ? apps.body.apps
    : status.body?.manifest
      ? [status.body.manifest]
      : [];
  const browserConfigs = serverBrowserConfigs.ok && serverBrowserConfigs.body?.browserConfigs
    ? serverBrowserConfigs.body.browserConfigs
    : [];
  const proxyStatusById = new Map(proxyStatuses.map((status) => [status.id, status]));
  const proxyList = (proxies.ok && proxies.body?.proxies
    ? proxies.body.proxies
    : status.body?.proxies ?? []).map((proxy) => ({
      ...proxy,
      running: proxyStatusById.get(proxy.id)?.running,
    }));
  const brokerStatus = mergeBrokerStatus({
    direct: brokerStatusFetch.ok ? brokerStatusFetch.body : undefined,
    viaServer: status.body?.broker?.status,
  });
  const networkList = brokerNetworks.ok && brokerNetworks.body?.networks
    ? brokerNetworks.body.networks
    : serverNetworks.ok && serverNetworks.body?.networks
      ? serverNetworks.body.networks
      : brokerStatus?.networks ?? [];
  const proxyForwards = brokerForwards.ok && brokerForwards.body?.forwards
    ? brokerForwards.body.forwards
    : brokerStatus?.proxyForwards ?? [];
  const sessions = serverSessions.ok && serverSessions.body?.sessions
    ? serverSessions.body.sessions.map((session) => ({
      ...session,
      slot: session.scope,
    }))
    : [];
  const browserList = raw.server.browsers?.ok && raw.server.browsers.body?.browsers
    ? raw.server.browsers.body.browsers.map(normalizeBrowser)
    : [];
  const relationships = computeRelationships({ apps: appList, browserConfigs: browserConfigs, sessions, proxies: proxyList, networks: networkList, proxyForwards, brokerStatus });

  return {
    serverOk,
    status,
    broker: status.body?.broker,
    brokerStatus,
    brokers: brokerEntries,
    browserConfigs: browserConfigs,
    proxyStatus,
    apps: appList,
    proxies: proxyList,
    networks: networkList,
    proxyForwards,
    sessions,
    browsers: browserList,
    relationships,
    errors: [status, apps, serverBrowserConfigs, serverSessions, proxies, serverNetworks, brokerStatusFetch, brokerNetworks, brokerForwards, proxyStatus, ...brokerEntries.map((entry) => entry.fetch)].filter((item) => !item.ok),
    updatedAt: new Date(raw.collectedAt),
  };
}

function normalizeBrowser(browser) {
  const session = browser.runtime ?? browser.sessions?.[0];
  const sessionId = browser.sessionId ?? session?.sessionId;
  return {
    ...browser,
    sessionId,
    profile: browser.profile ?? session?.profile,
    proxyId: browser.proxyId ?? session?.proxyId,
    status: browser.status ?? (sessionId ? 'occupied' : 'ready'),
    occupancy: browser.occupancy ?? (sessionId ? { state: 'unclaimed' } : { state: 'ready' }),
  };
}

function normalizeBrokerEntries(raw) {
  const primaryViaServer = raw.server.status.body?.broker?.status;
  const entries = Array.isArray(raw.brokers) && raw.brokers.length
    ? raw.brokers
    : [{
      url: raw.urls?.brokerUrl,
      status: raw.broker.status,
      networks: raw.broker.networks,
      proxyForwards: raw.broker.proxyForwards,
    }];
  return entries.map((entry) => ({
    url: entry.url,
    discovered: entry.discovered === true,
    fetch: entry.status,
    status: mergeBrokerStatus({
      direct: entry.status?.ok ? entry.status.body : undefined,
      viaServer: entry.url === raw.urls?.brokerUrl ? primaryViaServer : undefined,
    }),
    networks: entry.networks,
    proxyForwards: entry.proxyForwards,
  }));
}

function computeRelationships({ apps, browserConfigs, sessions, proxies, networks, proxyForwards, brokerStatus }) {
  const relationships = new Map();
  const add = (type, id, label) => {
    if (!id || !label) return;
    const key = `${type}:${id}`;
    if (!relationships.has(key)) relationships.set(key, []);
    relationships.get(key).push(label);
  };

  for (const app of apps) {
    add('app', app.id, `sessions: ${sessions.filter((session) => session.appId === app.id).map((session) => session.sessionId).join(', ')}`);
    add('network', app.networkId, `apps: ${app.id}`);
    add('proxy', app.proxyId, `apps: ${app.id}`);
    add('proxyForward', app.proxyForwardId, `apps: ${app.id}`);
  }

  for (const browserConfig of browserConfigs) {
    add('browserConfig', browserConfig.id, `profile: ${browserConfig.profile ?? browserConfig.id}`);
    add('profile', browserConfig.profile, `browser configs: ${browserConfig.id}`);
  }

  for (const session of sessions) {
    add('session', session.sessionId, `src app: ${session.appId}`);
    add('session', session.sessionId, `browser: ${session.browserId}`);
    add('browser', session.browserId, `sessions: ${session.sessionId}`);
    add('browserConfig', session.browserConfigId, `sessions: ${session.sessionId}`);
    add('network', session.networkId, `sessions: ${session.sessionId}`);
    add('proxy', session.proxyId, `sessions: ${session.sessionId}`);
    add('proxyForward', session.proxyForwardId, `sessions: ${session.sessionId}`);
    add('profile', session.profile, `sessions: ${session.sessionId}`);
  }

  for (const proxy of proxies) {
    add('proxy', proxy.id, proxy.appId ? `app: ${proxy.appId}` : undefined);
    add('proxy', proxy.id, proxy.taskId ? `task: ${proxy.taskId}` : undefined);
    add('app', proxy.appId, `proxies: ${proxy.id}`);
    add('task', proxy.taskId, `proxies: ${proxy.id}`);
    add('proxyForward', proxy.brokerProxyForwardId, `proxies: ${proxy.id}`);
  }

  for (const network of networks) {
    add('network', network.id, network.inUseBy?.length ? `broker instances: ${joinList(network.inUseBy)}` : undefined);
    add('proxyForward', network.resolved?.proxyForwardId, `networks: ${network.id}`);
    if (network.inUseBy?.length) {
      add('network', network.id, `in use by: ${joinList(network.inUseBy)}`);
    }
  }

  for (const forward of proxyForwards) {
    for (const instanceId of forward.inUseBy ?? []) {
      add('proxyForward', forward.forwardId, `broker instances: ${instanceId}`);
    }
  }

  for (const instance of brokerStatus?.instances ?? []) {
    add('network', instance.networkId, `broker instances: ${instance.id}`);
    add('proxyForward', instance.proxyForwardId, `broker instances: ${instance.id}`);
    add('profile', instance.profile, `broker instances: ${instance.id}`);
  }

  return relationships;
}

function related(relationships, type, id) {
  if (!id) return undefined;
  return joinList([...(relationships.get(`${type}:${id}`) ?? [])]);
}

async function render(snapshot) {
  els.serverState.textContent = snapshot.serverOk ? 'Online' : 'Error';
  els.serverState.className = snapshot.serverOk ? 'good-text' : 'bad-text';

  const brokerReachable = snapshot.brokers.some((broker) => broker.status);
  els.brokerState.replaceChildren();
  for (const [index, broker] of snapshot.brokers.entries()) {
    const line = document.createElement('div');
    line.textContent = `${index + 1} ${brokerLabel(broker.status)}`;
    line.className = `metric-status ${broker.status ? 'good-text' : 'bad-text'}`;
    els.brokerState.append(line);
  }
  if (!snapshot.brokers.length) els.brokerState.textContent = 'None';
  els.brokerState.className = brokerReachable ? 'good-text' : 'bad-text';

  els.sessionsState.textContent = `${snapshot.sessions.length} active`;
  els.sessionsState.className = snapshot.sessions.length ? 'good-text' : 'good-text';

  els.updatedAt.textContent = snapshot.updatedAt.toLocaleTimeString();

  setCount('browsers', snapshot.browsers.length);
  setCount('apps', snapshot.apps.length);
  setCount('broker', snapshot.brokers.length);
  setCount('browser-configs', snapshot.browserConfigs.length);
  setCount('sessions', snapshot.sessions.length);
  setCount('proxies', snapshot.proxies.length);

  await refreshBrowserPreviews(snapshot.browsers);
  renderBrowsers(snapshot.browsers);
  renderApps(snapshot.apps, snapshot.relationships, snapshot.browsers);
  renderBroker(snapshot);
  renderBrowserConfigs(snapshot.browserConfigs, snapshot.sessions, snapshot.browsers);
  renderSessions(snapshot.sessions, snapshot.relationships, snapshot.browsers);
  renderProxies(snapshot.proxies, snapshot.relationships, snapshot.browsers, snapshot.apps, snapshot.sessions);
}

function openBrowserEditor(browser) {
  state.editingBrowserId = browser?.id;
  syncBrowserEditorOptions(state.last);
  els.browserEditorTitle.textContent = browser ? `Edit ${browser.name ?? browser.id}` : 'New browser';
  els.browserId.value = browser?.id ?? '';
  els.browserId.disabled = Boolean(browser);
  els.browserName.value = browser?.name ?? '';
  els.browserConfigId.value = browser?.browserConfigId ?? state.last?.browserConfigs?.[0]?.id ?? '';
  els.browserAppId.value = browser?.appId ?? '';
  els.browserProxyId.value = browser?.proxyId ?? '';
  els.browserProxyIds.value = browser?.proxyId ? '' : (browser?.proxyIds ?? []).join(', ');
  els.browserProfile.value = browser?.profile ?? '';
  els.browserReadme.value = browser?.readme ?? '';
  els.browserEditorError.textContent = '';
  els.browserEditor.classList.remove('hidden');
  els.browserId.focus();
}

function closeBrowserEditor() {
  state.editingBrowserId = undefined;
  els.browserEditor.classList.add('hidden');
  els.browserEditorError.textContent = '';
}

function syncBrowserEditorOptions(snapshot) {
  if (!snapshot) return;
  setSelectOptions(els.browserConfigId, snapshot.browserConfigs, { required: true });
  setSelectOptions(els.browserAppId, snapshot.apps, { emptyLabel: 'No app' });
  const reservedByOtherBrowser = new Set((snapshot.browsers ?? [])
    .filter((browser) => browser.id !== state.editingBrowserId && browser.proxyId)
    .map((browser) => browser.proxyId));
  const availableProxies = (snapshot.proxies ?? []).filter((proxy) => !reservedByOtherBrowser.has(proxy.id));
  setSelectOptions(els.browserProxyId, availableProxies, { emptyLabel: 'No proxy' });
}

function setSelectOptions(select, values, { emptyLabel, required = false } = {}) {
  const selected = select.value;
  select.replaceChildren();
  if (emptyLabel !== undefined) {
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = emptyLabel;
    select.append(empty);
  }
  for (const value of values ?? []) {
    const option = document.createElement('option');
    option.value = value.id;
    option.textContent = value.name ? `${value.name} (${value.id})` : value.id;
    select.append(option);
  }
  select.required = required;
  if ([...select.options].some((option) => option.value === selected)) select.value = selected;
}

async function saveBrowser() {
  els.browserEditorError.textContent = '';
  const id = els.browserId.value.trim();
  const browser = omitEmpty({
    id,
    name: els.browserName.value.trim(),
    browserConfigId: els.browserConfigId.value,
    appId: els.browserAppId.value,
    proxyId: els.browserProxyId.value,
    proxyIds: els.browserProxyIds.value.split(',').map((value) => value.trim()).filter(Boolean),
    profile: els.browserProfile.value.trim(),
    readme: els.browserReadme.value.trim(),
  });
  if (!browser.id || !browser.browserConfigId) {
    els.browserEditorError.textContent = 'ID and browser config are required.';
    return;
  }
  if (browser.proxyId && browser.proxyIds) {
    els.browserEditorError.textContent = 'Choose a fixed proxy or a proxy pool, not both.';
    return;
  }
  try {
    await fetchJson('/api/pwdev/browsers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(browser),
    });
    closeBrowserEditor();
    await refresh();
  } catch (error) {
    els.browserEditorError.textContent = error.message;
  }
}

function openBrowserConfigEditor(browserConfig) {
  state.editingBrowserConfigId = browserConfig?.id;
  els.browserConfigEditorTitle.textContent = browserConfig ? `Edit ${browserConfig.name ?? browserConfig.id}` : 'New browser config';
  els.browserConfigIdEditor.value = browserConfig?.id ?? '';
  els.browserConfigIdEditor.disabled = Boolean(browserConfig);
  els.browserConfigName.value = browserConfig?.name ?? '';
  els.browserConfigTargetUrl.value = browserConfig?.targetUrl ?? '';
  els.browserConfigBrokerUrl.value = browserConfig?.brokerUrl ?? '';
  els.browserConfigProfile.value = browserConfig?.profile ?? '';
  els.browserConfigProxyBypassList.value = browserConfig?.proxyBypassList ?? '';
  els.browserConfigIgnoreSslErrors.checked = browserConfig?.ignoreSslErrors ?? true;
  els.browserConfigHeadless.checked = Boolean(browserConfig?.headless);
  els.browserConfigResetProfile.checked = Boolean(browserConfig?.resetProfile);
  els.browserConfigEditorError.textContent = '';
  els.browserConfigEditor.classList.remove('hidden');
  els.browserConfigIdEditor.focus();
}

function closeBrowserConfigEditor() {
  state.editingBrowserConfigId = undefined;
  els.browserConfigEditor.classList.add('hidden');
  els.browserConfigEditorError.textContent = '';
}

async function saveBrowserConfig() {
  els.browserConfigEditorError.textContent = '';
  const browserConfig = omitEmpty({
    id: els.browserConfigIdEditor.value.trim(),
    name: els.browserConfigName.value.trim(),
    targetUrl: els.browserConfigTargetUrl.value.trim(),
    brokerUrl: els.browserConfigBrokerUrl.value.trim(),
    profile: els.browserConfigProfile.value.trim(),
    proxyBypassList: els.browserConfigProxyBypassList.value.trim(),
    ignoreSslErrors: els.browserConfigIgnoreSslErrors.checked,
    headless: els.browserConfigHeadless.checked,
    resetProfile: els.browserConfigResetProfile.checked,
  });
  if (!browserConfig.id) {
    els.browserConfigEditorError.textContent = 'ID is required.';
    return;
  }
  try {
    await fetchJson('/api/pwdev/browser-configs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(browserConfig),
    });
    closeBrowserConfigEditor();
    await refresh();
  } catch (error) {
    els.browserConfigEditorError.textContent = error.message;
  }
}

async function deleteBrowserConfig(browserConfig) {
  if (!window.confirm(`Delete browser config ${browserConfig.name ?? browserConfig.id}?`)) return;
  try {
    await fetchJson(`/api/pwdev/browser-configs/${encodeURIComponent(browserConfig.id)}`, { method: 'DELETE' });
    if (state.editingBrowserConfigId === browserConfig.id) closeBrowserConfigEditor();
    await refresh();
  } catch (error) {
    window.alert(`Browser config delete failed: ${error.message}`);
  }
}

function omitEmpty(value) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => {
    if (Array.isArray(child)) return child.length > 0;
    return child !== undefined && child !== null && child !== '';
  }));
}

async function startBrowser(browser) {
  await mutateBrowser(browser, 'start', {});
}

async function stopBrowser(browser) {
  await mutateBrowser(browser, 'stop', {});
}

async function mutateBrowser(browser, action, body) {
  try {
    await fetchJson(`/api/pwdev/browsers/${encodeURIComponent(browser.id)}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await refresh();
  } catch (error) {
    window.alert(`Browser ${action} failed: ${error.message}`);
  }
}

async function deleteBrowser(browser) {
  if (!window.confirm(`Delete browser ${browser.name ?? browser.id}? This stops its session and removes the browser record.`)) return;
  try {
    await fetchJson(`/api/pwdev/browsers/${encodeURIComponent(browser.id)}`, { method: 'DELETE' });
    if (state.editingBrowserId === browser.id) closeBrowserEditor();
    await refresh();
  } catch (error) {
    window.alert(`Browser delete failed: ${error.message}`);
  }
}

function browserActions(browser) {
  const agentLease = browser.occupancy?.state === 'claimed' ? browser.occupancy : undefined;
  const deleteBlocked = Boolean(agentLease);
  return actionGroup([
    { label: 'Edit', onClick: () => openBrowserEditor(browser) },
    browser.sessionId
      ? { label: 'Monitor', onClick: () => openBrowserMonitor(browser) }
      : undefined,
    browser.sessionId
      ? { label: 'Stop', onClick: () => stopBrowser(browser) }
      : { label: 'Start', onClick: () => startBrowser(browser) },
    {
      label: 'Delete browser',
      disabled: deleteBlocked,
      title: deleteBlocked
        ? `Cannot delete: occupied by ${agentLease.owner}${agentLease.taskId ? `, task ${agentLease.taskId}` : ''}`
        : 'Delete browser',
      onClick: () => deleteBrowser(browser),
    },
  ]);
}

function openBrowserMonitor(browser) {
  window.open(`/monitor/${encodeURIComponent(browser.id)}`, '_blank', 'noopener,noreferrer');
}

async function refreshBrowserPreviews(browsers) {
  const activeIds = new Set(browsers.filter((browser) => browser.sessionId).map((browser) => browser.id));
  for (const [browserId, url] of state.previewUrls) {
    if (activeIds.has(browserId)) continue;
    URL.revokeObjectURL(url);
    state.previewUrls.delete(browserId);
  }
  await Promise.all(browsers.filter((browser) => browser.sessionId).map(async (browser) => {
    try {
      const response = await fetch(`/api/monitor/${encodeURIComponent(browser.id)}/preview`, { cache: 'no-store' });
      if (!response.ok) return;
      const url = URL.createObjectURL(await response.blob());
      const previous = state.previewUrls.get(browser.id);
      state.previewUrls.set(browser.id, url);
      if (previous) URL.revokeObjectURL(previous);
    } catch {
      // Keep the previous preview when a transient monitor capture fails.
    }
  }));
}

function actionGroup(actions) {
  return { actionGroup: true, actions: actions.filter(Boolean) };
}

function createActionButtons(actions = []) {
  const root = document.createElement('div');
  root.className = 'table-actions';
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.disabled = Boolean(action.disabled);
    if (action.title) button.title = action.title;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await action.onClick();
      } finally {
        button.disabled = false;
      }
    });
    root.append(button);
  }
  return root;
}

function renderBrowsers(browsers) {
  if (state.browserView === 'table') {
    els.browsersDiagram.classList.add('hidden');
    els.browsersTable.classList.remove('hidden');
    renderTable(els.browsersTable, [
      'Browser', 'Status', 'Lease', 'App', 'Proxy', 'Browser config', 'Profile', 'Session', 'Actions',
    ], browsers.map((browser) => [
      browser.name ?? browser.id,
      browser.status ?? (browser.sessionId ? 'Occupied' : 'Ready'),
      formatBrowserOccupancy(browser),
      appLink(browser.appId),
      proxyLink(browser.proxyId),
      browserConfigLink(browser.browserConfigId),
      browser.profile,
      sessionLink(browser.sessionId),
      browserActions(browser),
    ]), { rowKeys: browsers.map((browser) => browser.id), rowKeyAttribute: 'browserId' });
    return;
  }
  els.browsersTable.classList.add('hidden');
  els.browsersDiagram.classList.remove('hidden');
  renderBrowserDiagram(els.browsersDiagram, browsers);
}

function renderBrowserDiagram(root, browsers) {
  root.replaceChildren();
  if (!browsers.length) {
    root.append(emptyState('No browsers'));
    return;
  }
  for (const browser of browsers) {
    const card = document.createElement('article');
    card.className = 'browser-diagram card';
    const heading = document.createElement('div');
    heading.className = 'browser-diagram-title';
    const titleInfo = document.createElement('div');
    titleInfo.className = 'browser-diagram-info';
    const titleGroup = document.createElement('div');
    titleGroup.className = 'browser-diagram-name';
    const title = document.createElement('h3');
    title.textContent = browser.name ?? browser.id;
    titleGroup.append(title);
    const configLink = browserConfigLink(browser.browserConfigId);
    if (configLink) {
      const separator = document.createElement('span');
      separator.className = 'browser-config-separator';
      separator.textContent = '·';
      const browserConfigLabel = document.createElement('a');
      browserConfigLabel.className = 'browser-config-title-link entity-link mono';
      browserConfigLabel.textContent = configLink.text;
      browserConfigLabel.href = configLink.href;
      browserConfigLabel.addEventListener('click', (event) => {
        event.preventDefault();
        configLink.onClick();
      });
      titleGroup.append(separator, browserConfigLabel);
    }
    const occupancyLabel = document.createElement('div');
    occupancyLabel.className = 'browser-occupancy';
    occupancyLabel.textContent = `occupancy: ${formatBrowserOccupancy(browser)}`;
    titleInfo.append(titleGroup, occupancyLabel);
    const controls = document.createElement('div');
    controls.className = 'browser-diagram-controls';
    controls.append(createActionButtons(browserActions(browser).actions));
    heading.append(titleInfo, controls);
    card.append(heading);
    const flow = document.createElement('div');
    flow.className = 'browser-flow';
    const flowColumn = document.createElement('div');
    flowColumn.className = 'browser-flow-column';
    const nodes = [
      ['session', browser.sessionId ?? 'No active session', sessionLink(browser.sessionId)],
      ['proxy', browser.proxyId ?? 'No proxy', proxyLink(browser.proxyId)],
      ['app', browser.appId ?? 'No app', appLink(browser.appId)],
    ];
    for (const [index, [kind, label, link]] of nodes.entries()) {
      const node = document.createElement(link ? 'a' : 'div');
      node.className = `browser-node ${kind}`;
      if (kind === 'session' && !browser.sessionId) node.classList.add('inactive');
      node.textContent = label;
      if (link) {
        node.classList.add('entity-node-link', `${kind}-link`);
        node.href = link.href;
        node.addEventListener('click', (event) => {
          event.preventDefault();
          link.onClick();
        });
      }
      flowColumn.append(node);
      if (index < nodes.length - 1) {
        const arrow = document.createElement('span');
        arrow.className = 'browser-arrow';
        arrow.textContent = '↓';
        flowColumn.append(arrow);
      }
    }
    flow.append(flowColumn);
    const preview = document.createElement('section');
    preview.className = 'browser-preview';
    const previewUrl = state.previewUrls.get(browser.id);
    if (browser.sessionId && previewUrl) {
      preview.classList.add('enabled');
      preview.tabIndex = 0;
      preview.title = 'Open browser monitor';
      preview.setAttribute('role', 'button');
      preview.addEventListener('click', () => openBrowserMonitor(browser));
      preview.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openBrowserMonitor(browser);
        }
      });
      const image = document.createElement('img');
      image.alt = `Latest browser preview for ${browser.name ?? browser.id}`;
      image.src = previewUrl;
      preview.append(image);
    } else {
      preview.classList.add('empty');
      preview.textContent = browser.sessionId ? 'Loading preview…' : 'Start the browser to load a preview.';
    }
    flow.append(preview);
    card.append(flow);
    root.append(card);
  }
}

function brokerLabel(status) {
  if (!status) return 'offline';
  const running = status.state === 'active' ? 'active' : 'idle';
  if (status.topology?.remote) {
    return `remote ${running}`;
  }
  return status.topology?.mode ? `${status.topology.mode} ${running}` : running;
}

function mergeBrokerStatus({ direct, viaServer }) {
  if (!direct) return viaServer;
  if (!viaServer) return direct;
  return {
    ...viaServer,
    ...direct,
    topology: direct.topology ?? viaServer.topology,
    instances: direct.instances ?? viaServer.instances,
    networks: direct.networks ?? viaServer.networks,
    proxyForwards: direct.proxyForwards ?? viaServer.proxyForwards,
  };
}

function renderApps(apps, relationships, browsers) {
  renderTable(els.apps, ['App', 'URL', 'Branch', 'Used By', 'README'], apps.map((app) => [
    app.name ?? app.id,
    app.appUrl,
    app.branch,
    usedBy(browsers, 'appId', app.id),
    app.readme ? markdownView(app.readme, app.name ?? app.id) : undefined,
  ]), { rowKeys: apps.map((app) => app.id), rowKeyAttribute: 'appId' });
}

function renderBroker(snapshot) {
  renderCards(els.broker, snapshot.brokers.map((entry, index) => {
    const broker = entry.status;
    const active = broker?.state === 'active';
    const remoteMachine = broker?.topology?.ssh?.remoteMachine;
    const remoteOs = [remoteMachine?.platform, remoteMachine?.release].filter(Boolean).join(' ');
    return {
      title: `BROKER${index + 1}`,
      subtitle: entry.url,
      badge: [
        badge(broker ? (active ? 'Active' : 'Idle') : 'Offline', broker ? (active ? 'good' : 'neutral') : 'bad'),
        entry.discovered ? badge('Found on localhost', 'good') : '',
      ].join(' '),
      rows: {
        URL: entry.url,
        Topology: broker?.topology?.mode,
        Remote: broker?.topology?.remote ? 'Yes' : 'No',
        'SSH target': broker?.topology?.ssh?.target,
        'Remote hostname': remoteMachine?.hostname,
        'Remote IP addresses': joinList(remoteMachine?.addresses),
        'Remote OS / kernel': remoteOs,
        'Remote machine probe': remoteMachine?.error,
        Instances: broker?.instanceCount ?? broker?.instances?.length ?? 0,
        Networks: networkLink(broker?.networks),
      },
      actions: entry.discovered
        ? [{ label: 'Use in browser config', onClick: () => useDiscoveredBroker(entry.url) }]
        : undefined,
    };
  }));
}

function useDiscoveredBroker(url) {
  showView('browser-configs');
  openBrowserConfigEditor();
  els.browserConfigBrokerUrl.value = url;
  els.browserConfigBrokerUrl.focus();
}

function renderBrowserConfigs(browserConfigs, sessions, browsers) {
  renderTable(els.browserConfigs, ['Browser config', 'Target', 'Profile', 'Used By', 'Active sessions', 'Actions'], browserConfigs.map((browserConfig) => {
    const relatedSessions = sessions.filter((session) => session.browserConfigId === browserConfig.id);
    const activeSessions = relatedSessions.map((session) => formatBrowserSession(session));
    const usage = browserConfigUsage(browserConfig, browsers, sessions);
    return [
      browserConfig.name ?? browserConfig.id,
      browserConfig.targetUrl,
      browserConfig.profile ?? browserConfig.id,
      usedBy(browsers, 'browserConfigId', browserConfig.id),
      activeSessions.join(' · ') || 'None',
      browserConfigActions(browserConfig, usage),
    ];
  }), { rowKeys: browserConfigs.map((browserConfig) => browserConfig.id), rowKeyAttribute: 'browserConfigId' });
}

function browserConfigUsage(browserConfig, browsers, sessions) {
  const references = browsers
    .filter((browser) => browser.browserConfigId === browserConfig.id)
    .map((browser) => `browser:${browser.name ?? browser.id}`);
  const occupiedBy = sessions
    .filter((session) => session.browserConfigId === browserConfig.id)
    .map((session) => session.sessionId);
  return { references, occupiedBy };
}

function browserConfigActions(browserConfig, usage) {
  const referenced = usage.references.length > 0;
  const occupied = usage.occupiedBy.length > 0;
  return actionGroup([
    {
      label: 'Edit',
      disabled: referenced,
      title: referenced ? `Cannot edit: ${usage.references.join(', ')}` : 'Edit browser config',
      onClick: () => openBrowserConfigEditor(browserConfig),
    },
    {
      label: 'Delete config',
      disabled: referenced || occupied,
      title: occupied
        ? `Cannot delete: occupied by ${usage.occupiedBy.join(', ')}`
        : referenced
          ? `Cannot delete: referenced by ${usage.references.join(', ')}`
          : 'Delete browser config',
      onClick: () => deleteBrowserConfig(browserConfig),
    },
  ]);
}

function formatBrowserSession(session) {
  const scope = session.scope === 'task' ? `task ${session.taskId ?? session.sessionId}` : 'default';
  const profile = session.profile ? `profile ${session.profile}` : undefined;
  const instance = session.browserInstanceId ? `instance ${session.browserInstanceId}` : undefined;
  const lease = formatSessionLease(session);
  return [session.sessionId, scope, profile, instance, lease].filter(Boolean).join(' — ');
}

function renderSessions(sessions, relationships, browsers) {
  renderTable(els.sessions, ['Session', 'Browser', 'Browser config', 'App', 'Proxy', 'Profile', 'Lease', 'Used By', 'Instance'], sessions.map((session) => [
    session.sessionId,
    session.browserId,
    session.browserConfigId,
    session.appId,
    session.proxyId,
    session.profile,
    formatSessionLease(session),
    usedBy(browsers, 'sessionId', session.sessionId),
    session.browserInstanceId,
  ]), { rowKeys: sessions.map((session) => session.sessionId) });
}

function formatBrowserOccupancy(browser) {
  if (browser.status !== 'occupied' && !browser.sessionId) return 'Ready';
  const occupancy = browser.occupancy;
  if (!occupancy || occupancy.state === 'unclaimed') return 'Unclaimed';
  return formatLeaseDetails(occupancy);
}

function formatSessionLease(session) {
  if (!session?.lease) return session?.sessionId ? 'Unclaimed' : undefined;
  return formatLeaseDetails(session.lease);
}

function formatLeaseDetails(lease) {
  return [
    lease.owner,
    lease.agentId ? `agent ${lease.agentId}` : undefined,
    lease.taskId ? `task ${lease.taskId}` : undefined,
    lease.heartbeatAt ? `heartbeat ${formatTime(lease.heartbeatAt)}` : undefined,
  ].filter(Boolean).join(' · ');
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

function sessionLink(sessionId) {
  if (!sessionId) return undefined;
  return {
    link: true,
    text: sessionId,
    href: '#sessions',
    onClick: () => showSession(sessionId),
  };
}

function appLink(appId) {
  if (!appId) return undefined;
  return {
    link: true,
    text: appId,
    href: '#apps',
    onClick: () => showApp(appId),
  };
}

function proxyLink(proxyId) {
  if (!proxyId) return undefined;
  return {
    link: true,
    text: proxyId,
    href: '#proxies',
    onClick: () => showProxy(proxyId),
  };
}

function browserConfigLink(browserConfigId) {
  if (!browserConfigId) return undefined;
  return {
    link: true,
    text: browserConfigId,
    href: '#browser-configs',
    onClick: () => showBrowserConfig(browserConfigId),
  };
}

function networkLink(networks = []) {
  const ids = networks.map((network) => network.id).filter(Boolean);
  if (!ids.length) return '0';
  return {
    link: true,
    text: ids.join(', '),
    href: '#networks',
    onClick: () => ids.length === 1 ? showNetwork(ids[0]) : showView('networks'),
  };
}

function renderNetworks(networks, relationships) {
  renderCards(els.networks, networks.map((network) => ({
    networkId: network.id,
    title: network.name ?? network.id,
    subtitle: network.id,
    badge: badge(
      network.lastProbeReachable === true ? 'SSH tunnel alive' :
        network.lastProbeReachable === false ? 'SSH tunnel failed' :
          network.proxy?.mode ?? 'network',
      network.lastProbeReachable === true ? 'good' :
        network.lastProbeReachable === false ? 'bad' :
          network.proxy?.mode === 'ssh-peer' ? 'warn' : 'neutral'
    ),
    rows: {
      Kind: network.kind,
      Owner: network.owner,
      Purpose: network.purpose,
      Server: network.proxy?.server,
      'Remote port': network.proxy?.remotePort,
      'Local port': network.proxy?.localPort,
      'Proxy server': network.resolved?.proxyServer,
      'Proxy forward': network.resolved?.proxyForwardId,
      Probe: network.lastProbe?.statusCode,
      'Probe latency': network.lastProbe?.latencyMs ? `${network.lastProbe.latencyMs}ms` : undefined,
      'In use by': joinList(network.inUseBy),
      Related: related(relationships, 'network', network.id),
      Updated: formatDate(network.updatedAt),
    },
    actions: network.proxy?.mode === 'ssh-peer'
      ? [{ label: 'Probe tunnel', onClick: () => probeNetwork(network.id) }]
      : undefined,
  })));
}

async function probeNetwork(networkId) {
  try {
    const result = await fetchJson(`/api/network-check/${encodeURIComponent(networkId)}`, { method: 'POST' });
    const network = state.last?.networks?.find((item) => item.id === networkId);
    if (network && result.probe) {
      network.lastProbe = result.probe;
      network.lastProbeReachable = result.reachable;
    }
    if (state.last) await render(state.last);
  } catch (error) {
    console.error(`Network probe failed: ${error.message}`);
  }
}

function openProxyEditor(proxy) {
  state.editingProxyId = proxy?.id;
  els.proxyEditorTitle.textContent = proxy ? `Edit ${proxy.name ?? proxy.id}` : 'New proxy';
  els.proxyId.value = proxy?.id ?? '';
  els.proxyId.disabled = Boolean(proxy);
  els.proxyName.value = proxy?.name ?? '';
  els.proxyKind.value = proxy?.kind ?? '';
  els.proxyUrl.value = proxy?.proxyUrl ?? '';
  els.proxyForwardId.value = proxy?.brokerProxyForwardId ?? '';
  els.proxyGuiUrl.value = proxy?.guiUrl ?? '';
  els.proxyOwner.value = proxy?.owner ?? '';
  els.proxyTaskId.value = proxy?.taskId ?? '';
  els.proxyPurpose.value = proxy?.purpose ?? '';
  els.proxyLabels.value = (proxy?.labels ?? []).join(', ');
  els.proxyEditorError.textContent = '';
  els.proxyEditor.classList.remove('hidden');
  els.proxyId.focus();
}

function closeProxyEditor() {
  state.editingProxyId = undefined;
  els.proxyEditor.classList.add('hidden');
  els.proxyEditorError.textContent = '';
}

async function saveProxy() {
  els.proxyEditorError.textContent = '';
  const proxy = omitEmpty({
    id: els.proxyId.value.trim(),
    name: els.proxyName.value.trim(),
    kind: els.proxyKind.value.trim(),
    proxyUrl: els.proxyUrl.value.trim(),
    brokerProxyForwardId: els.proxyForwardId.value.trim(),
    guiUrl: els.proxyGuiUrl.value.trim(),
    owner: els.proxyOwner.value.trim(),
    taskId: els.proxyTaskId.value.trim(),
    purpose: els.proxyPurpose.value.trim(),
    labels: els.proxyLabels.value.split(',').map((value) => value.trim()).filter(Boolean),
  });
  if (!proxy.id || (!proxy.proxyUrl && !proxy.brokerProxyForwardId)) {
    els.proxyEditorError.textContent = 'ID and a proxy URL or broker forward ID are required.';
    return;
  }
  if (proxy.proxyUrl && proxy.brokerProxyForwardId) {
    els.proxyEditorError.textContent = 'Choose a proxy URL or broker forward ID, not both.';
    return;
  }
  try {
    await fetchJson('/api/pwdev/proxies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(proxy),
    });
    closeProxyEditor();
    await refresh();
  } catch (error) {
    els.proxyEditorError.textContent = error.message;
  }
}

async function deleteProxy(proxy) {
  if (!window.confirm(`Delete proxy ${proxy.name ?? proxy.id}?`)) return;
  try {
    await fetchJson(`/api/pwdev/proxies/${encodeURIComponent(proxy.id)}`, { method: 'DELETE' });
    if (state.editingProxyId === proxy.id) closeProxyEditor();
    await refresh();
  } catch (error) {
    window.alert(`Proxy delete failed: ${error.message}`);
  }
}

function proxyUsage(proxy, browsers, apps, sessions) {
  const browserReferences = browsers
    .filter((browser) => browser.proxyId === proxy.id || browser.proxyIds?.includes(proxy.id))
    .map((browser) => `browser:${browser.name ?? browser.id}`);
  const appReferences = apps
    .filter((app) => app.proxyId === proxy.id)
    .map((app) => `app:${app.name ?? app.id}`);
  const occupiedBy = sessions
    .filter((session) => session.proxyId === proxy.id)
    .map((session) => session.sessionId);
  return {
    references: [...browserReferences, ...appReferences],
    occupiedBy,
  };
}

function proxyActions(proxy, usage) {
  const referenced = usage.references.length > 0;
  const occupied = usage.occupiedBy.length > 0;
  return actionGroup([
    {
      label: 'Edit',
      disabled: referenced,
      title: referenced ? `Cannot edit: ${usage.references.join(', ')}` : 'Edit proxy',
      onClick: () => openProxyEditor(proxy),
    },
    {
      label: 'Delete proxy',
      disabled: referenced || occupied,
      title: occupied
        ? `Cannot delete: occupied by ${usage.occupiedBy.join(', ')}`
        : referenced
          ? `Cannot delete: referenced by ${usage.references.join(', ')}`
          : 'Delete proxy',
      onClick: () => deleteProxy(proxy),
    },
  ]);
}

function renderProxies(proxies, relationships, browsers, apps, sessions) {
  renderTable(els.proxies, ['Proxy', 'Status', 'URL', 'GUI URL', 'Owner', 'Purpose', 'Referenced By', 'Occupied By', 'Actions'], proxies.map((proxy) => {
    const usage = proxyUsage(proxy, browsers, apps, sessions);
    return [
    proxy.name ?? proxy.id,
    usage.occupiedBy.length ? 'Occupied' : proxy.running === true ? 'Running' : proxy.running === false ? 'Stopped' : proxy.managed ? 'Managed' : proxy.kind ?? 'Proxy',
    proxy.proxyUrl,
    proxy.guiUrl ? proxyGuiLink(proxy.id) : undefined,
    proxy.owner,
    proxy.purpose,
    usage.references.join(', ') || '—',
    usage.occupiedBy.join(', ') || '—',
    proxyActions(proxy, usage),
  ];
  }), { rowKeys: proxies.map((proxy) => proxy.id), rowKeyAttribute: 'proxyId' });
}

function proxyGuiLink(proxyId) {
  const href = `/proxy/${encodeURIComponent(proxyId)}/gui/`;
  return {
    link: true,
    newTab: true,
    text: new URL(href, window.location.origin).href,
    href,
  };
}

function usedBy(browsers = [], field, id) {
  return browsers
    .filter((browser) => browser?.[field] === id)
    .map((browser) => browser.name ?? browser.id)
    .join(', ') || '—';
}

function renderTable(root, columns, rows, { rowKeys = [], rowKeyAttribute = 'sessionId' } = {}) {
  root.replaceChildren();
  if (!rows.length) {
    root.append(emptyState());
    return;
  }
  const table = document.createElement('table');
  table.className = 'entity-table';
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const column of columns) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = column;
    headerRow.append(cell);
  }
  head.append(headerRow);
  table.append(head);
  const body = document.createElement('tbody');
  for (const [index, row] of rows.entries()) {
    const tableRow = document.createElement('tr');
    if (rowKeys[index]) {
      tableRow.dataset[rowKeyAttribute] = rowKeys[index];
      tableRow.tabIndex = -1;
    }
    for (const value of row) {
      const cell = document.createElement('td');
      if (isActionGroup(value)) {
        cell.append(createActionButtons(value.actions));
      } else if (isCardLink(value)) {
        const link = document.createElement('a');
        link.className = 'entity-link mono';
        link.href = value.href ?? '#';
        link.textContent = value.text;
        if (value.newTab) {
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        } else {
          link.addEventListener('click', (event) => {
            event.preventDefault();
            value.onClick();
          });
        }
        cell.append(link);
      } else if (isMarkdownView(value)) {
        cell.append(createMarkdownViewer(value));
      } else {
        cell.textContent = isCopyableText(value)
          ? value.text
          : value === undefined || value === null || value === '' ? '—' : String(value);
      }
      tableRow.append(cell);
    }
    body.append(tableRow);
  }
  table.append(body);
  const scroll = document.createElement('div');
  scroll.className = 'table-scroll';
  scroll.append(table);
  root.append(scroll);
}

function renderCards(root, cards) {
  root.replaceChildren();
  if (!cards.length) {
    root.append(emptyState());
    return;
  }

  for (const item of cards) {
    const card = document.createElement('article');
    card.className = 'card';
    if (item.appId) {
      card.dataset.appId = item.appId;
      card.tabIndex = -1;
    }
    if (item.networkId) {
      card.dataset.networkId = item.networkId;
      card.tabIndex = -1;
    }

    const head = document.createElement('div');
    head.className = 'card-head';
    const titleWrap = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = item.title ?? 'Untitled';
    const subtitle = document.createElement('div');
    subtitle.className = 'id';
    subtitle.textContent = item.subtitle ?? '';
    titleWrap.append(title, subtitle);
    head.append(titleWrap);
    if (item.badge) {
      const badgeRow = document.createElement('div');
      badgeRow.className = 'badge-row';
      badgeRow.innerHTML = item.badge;
      head.append(badgeRow);
    }
    card.append(head);

    const list = document.createElement('dl');
    list.className = 'kv';
    for (const [label, value] of Object.entries(item.rows ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      if (isCardLink(value)) {
        const link = document.createElement('a');
        link.className = 'entity-link mono';
        link.href = value.href ?? '#';
        link.textContent = value.text;
        if (value.newTab) {
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        } else {
          link.addEventListener('click', (event) => {
            event.preventDefault();
            value.onClick();
          });
        }
        dd.append(link);
      } else if (isCopyableText(value)) {
        const text = document.createElement('span');
        text.className = 'ellipsis-text';
        text.textContent = value.text;
        text.title = value.text;
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'copy-button';
        copy.textContent = 'Copy';
        copy.title = 'Copy full README text';
        copy.addEventListener('click', async () => {
          copy.disabled = true;
          try {
            await copyText(value.text);
            copy.textContent = 'Copied';
          } finally {
            window.setTimeout(() => {
              copy.textContent = 'Copy';
              copy.disabled = false;
            }, 1000);
          }
        });
        dd.className = 'copyable-value';
        dd.append(text, copy);
      } else {
        dd.className = looksCodeLike(value) ? 'mono' : '';
        dd.textContent = String(value);
      }
      list.append(dt, dd);
    }
    card.append(list);
    if (item.actions?.length) {
      const actions = document.createElement('div');
      actions.className = 'card-actions';
      for (const action of item.actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = action.label;
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await action.onClick();
          } finally {
            button.disabled = false;
          }
        });
        actions.append(button);
      }
      card.append(actions);
    }
    root.append(card);
  }
}

function isCardLink(value) {
  return typeof value === 'object' && value !== null && value.link === true;
}

function isActionGroup(value) {
  return typeof value === 'object' && value !== null && value.actionGroup === true;
}

function markdownView(text, title) {
  return { markdownView: true, text, title };
}

function isMarkdownView(value) {
  return typeof value === 'object' && value !== null && value.markdownView === true;
}

function createMarkdownViewer(value) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'readme-button';
  button.textContent = 'View README';
  button.addEventListener('click', () => openMarkdownModal(value.title, value.text));
  return button;
}

function openMarkdownModal(title, text) {
  state.markdownModalText = text;
  els.markdownModalTitle.textContent = 'README';
  els.markdownModalSubtitle.textContent = title ?? '';
  renderMarkdown(els.markdownModalContent, text);
  els.copyMarkdownModal.textContent = 'Copy README';
  els.markdownModal.classList.remove('hidden');
  document.body.classList.add('modal-open');
  els.closeMarkdownModal.focus();
}

function closeMarkdownModal() {
  els.markdownModal.classList.add('hidden');
  document.body.classList.remove('modal-open');
}

async function copyMarkdownModal() {
  els.copyMarkdownModal.disabled = true;
  try {
    await copyText(state.markdownModalText);
    els.copyMarkdownModal.textContent = 'Copied';
  } finally {
    window.setTimeout(() => {
      els.copyMarkdownModal.textContent = 'Copy README';
      els.copyMarkdownModal.disabled = false;
    }, 1000);
  }
}

function renderMarkdown(root, markdown) {
  root.replaceChildren();
  const lines = String(markdown ?? '').split(/\r?\n/);
  let paragraph = [];
  let list;
  let code;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const node = document.createElement('p');
    appendInlineMarkdown(node, paragraph.join(' '));
    root.append(node);
    paragraph = [];
  };
  const flushList = () => {
    if (list) root.append(list);
    list = undefined;
  };
  const flushCode = () => {
    if (!code) return;
    const pre = document.createElement('pre');
    const codeNode = document.createElement('code');
    codeNode.textContent = code.lines.join('\n');
    pre.append(codeNode);
    root.append(pre);
    code = undefined;
  };

  for (const line of lines) {
    if (code) {
      if (/^\s*```/.test(line)) flushCode();
      else code.lines.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) {
      flushParagraph();
      flushList();
      code = { lines: [] };
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = line.match(/^\s*(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      flushList();
      const node = document.createElement(`h${heading[1].length + 2}`);
      appendInlineMarkdown(node, heading[2]);
      root.append(node);
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const tag = unordered ? 'ul' : 'ol';
      if (!list || list.tagName.toLowerCase() !== tag) {
        flushList();
        list = document.createElement(tag);
      }
      const item = document.createElement('li');
      appendInlineMarkdown(item, (unordered ?? ordered)[1]);
      list.append(item);
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  flushCode();
}

function appendInlineMarkdown(root, text) {
  const tokenPattern = /(\`[^\`]+\`|\[[^\]]+\]\([^\s)]+\)|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  for (const match of String(text).matchAll(tokenPattern)) {
    if (match.index > lastIndex) root.append(document.createTextNode(text.slice(lastIndex, match.index)));
    const token = match[0];
    if (token.startsWith('`')) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      root.append(code);
    } else if (token.startsWith('[')) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/);
      const href = safeMarkdownHref(linkMatch?.[2]);
      if (!href) root.append(document.createTextNode(linkMatch?.[1] ?? token));
      else {
        const link = document.createElement('a');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = linkMatch[1];
        root.append(link);
      }
    } else if (token.startsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      root.append(strong);
    } else {
      const emphasis = document.createElement('em');
      emphasis.textContent = token.slice(1, -1);
      root.append(emphasis);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) root.append(document.createTextNode(text.slice(lastIndex)));
}

function safeMarkdownHref(value) {
  try {
    const url = new URL(value, window.location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function copyableText(text) {
  return { copyableText: true, text };
}

function isCopyableText(value) {
  return typeof value === 'object' && value !== null && value.copyableText === true;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}

function emptyState(message = 'No records') {
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent = message;
  return empty;
}

function badge(label, tone) {
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

function badgeElement(label, tone) {
  const node = document.createElement('span');
  node.className = `badge ${tone}`;
  node.textContent = label;
  return node;
}

function setCount(name, value) {
  const target = document.querySelector(`#count-${name}`);
  if (target) target.textContent = String(value);
}

function formatDate(value) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

function joinList(list) {
  const values = [...new Set((list ?? []).filter(Boolean))];
  return values.length ? values.join(', ') : undefined;
}

function looksCodeLike(value) {
  return /https?:\/\/|^\/|[A-Za-z0-9_-]+:[A-Za-z0-9_-]+/.test(String(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { accept: 'application/json', ...(options.headers ?? {}) },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${path}`);
  }
  return response.json();
}
