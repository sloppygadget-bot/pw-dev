const state = {
  timer: undefined,
  intervalMs: 5000,
  refreshGeneration: 0,
  pwDevUrl: '',
  currentView: 'browsers',
  last: undefined,
  browserView: 'diagram',
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

function focusEntityRow(root, dataKey, id, targetClass) {
  const row = [...root.querySelectorAll(`[data-${dataKey.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}]`)]
    .find((item) => item.dataset[dataKey] === id);
  if (!row) return;
  for (const target of root.querySelectorAll('.entity-target')) {
    target.classList.remove('entity-target', 'app-target', 'proxy-target', 'session-target');
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
    browsers: raw.server.browsers?.ok && raw.server.browsers.body?.browsers
      ? raw.server.browsers.body.browsers
      : [],
    relationships,
    errors: [status, apps, serverBrowserConfigs, serverSessions, proxies, serverNetworks, brokerStatusFetch, brokerNetworks, brokerForwards, proxyStatus, ...brokerEntries.map((entry) => entry.fetch)].filter((item) => !item.ok),
    updatedAt: new Date(raw.collectedAt),
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
  setSelectOptions(els.browserProxyId, snapshot.proxies, { emptyLabel: 'No proxy' });
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
  els.browserConfigIgnoreSslErrors.checked = Boolean(browserConfig?.ignoreSslErrors);
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
      ? { label: 'Delete session', onClick: () => stopBrowser(browser) }
      : { label: 'Create session', onClick: () => startBrowser(browser) },
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
      browser.browserConfigId,
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
    const title = document.createElement('h3');
    title.textContent = browser.name ?? browser.id;
    card.append(title);
    const flow = document.createElement('div');
    flow.className = 'browser-flow';
    const nodes = [
      ['session', browser.sessionId ?? 'No active session', sessionLink(browser.sessionId)],
      ['proxy', browser.proxyId ?? 'No proxy', proxyLink(browser.proxyId)],
      ['app', browser.appId ?? 'No app', appLink(browser.appId)],
    ];
    for (const [index, [kind, label, link]] of nodes.entries()) {
      const node = document.createElement(link ? 'a' : 'div');
      node.className = `browser-node ${kind}`;
      node.textContent = label;
      if (link) {
        node.classList.add('entity-node-link', `${kind}-link`);
        node.href = link.href;
        node.addEventListener('click', (event) => {
          event.preventDefault();
          link.onClick();
        });
      }
      flow.append(node);
      if (index < nodes.length - 1) {
        const arrow = document.createElement('span');
        arrow.className = 'browser-arrow';
        arrow.textContent = '→';
        flow.append(arrow);
      }
    }
    const browserConfigLabel = document.createElement('div');
    browserConfigLabel.className = 'browser-config-label';
    browserConfigLabel.textContent = `spawned from ${browser.browserConfigId ?? 'browser config'}`;
    const occupancyLabel = document.createElement('div');
    occupancyLabel.className = 'browser-config-label';
    occupancyLabel.textContent = `occupancy: ${formatBrowserOccupancy(browser)}`;
    card.append(flow, browserConfigLabel, occupancyLabel, createActionButtons(browserActions(browser).actions));
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
    app.readme ? copyableText(app.readme) : undefined,
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
      badge: badge(broker ? (active ? 'Active' : 'Idle') : 'Offline', broker ? (active ? 'good' : 'neutral') : 'bad'),
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
    };
  }));
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
  root.append(table);
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
