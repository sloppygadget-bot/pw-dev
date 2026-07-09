const state = {
  timer: undefined,
  intervalMs: 5000,
  pwDevUrl: '',
  currentView: 'overview',
  last: undefined,
};

const els = {
  target: document.querySelector('#target'),
  interval: document.querySelector('#interval'),
  refresh: document.querySelector('#refresh'),
  serverState: document.querySelector('#server-state'),
  brokerState: document.querySelector('#broker-state'),
  updatedAt: document.querySelector('#updated-at'),
  overview: document.querySelector('#overview-grid'),
  apps: document.querySelector('#apps-list'),
  sessions: document.querySelector('#sessions-list'),
  networks: document.querySelector('#networks-list'),
  proxies: document.querySelector('#proxies-list'),
};

for (const button of document.querySelectorAll('.nav-item')) {
  button.addEventListener('click', () => showView(button.dataset.view));
}

els.refresh.addEventListener('click', () => void refresh());
els.interval.addEventListener('change', () => {
  state.intervalMs = Number(els.interval.value);
  schedule();
});

void init();

async function init() {
  const config = await fetchJson('/api/config');
  state.pwDevUrl = config.pwDevUrl;
  els.target.textContent = `server ${config.pwDevUrl} | broker ${config.brokerUrl} | proxy ${config.proxyManagerUrl}`;
  await refresh();
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

async function refresh() {
  els.refresh.disabled = true;
  try {
    const snapshot = normalizeSnapshot(await fetchJson('/api/snapshot'));
    state.last = snapshot;
    render(snapshot);
  } finally {
    els.refresh.disabled = false;
  }
}

function normalizeSnapshot(raw) {
  const status = raw.server.status;
  const apps = raw.server.apps;
  const proxies = raw.server.proxies;
  const serverNetworks = raw.server.networks;
  const brokerStatusFetch = raw.broker.status;
  const brokerNetworks = raw.broker.networks;
  const brokerForwards = raw.broker.proxyForwards;
  const proxyStatus = raw.proxyManager.status;

  const serverOk = status.ok && status.body?.ok;
  const appList = apps.ok && apps.body?.apps
    ? apps.body.apps
    : status.body?.manifest
      ? [status.body.manifest]
      : [];
  const proxyList = proxies.ok && proxies.body?.proxies
    ? proxies.body.proxies
    : status.body?.proxies ?? [];
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
  const sessions = appList.flatMap((app) => sessionsForApp(app));
  const relationships = computeRelationships({ apps: appList, sessions, proxies: proxyList, networks: networkList, proxyForwards, brokerStatus });

  return {
    serverOk,
    status,
    broker: status.body?.broker,
    brokerStatus,
    proxyStatus,
    apps: appList,
    proxies: proxyList,
    networks: networkList,
    proxyForwards,
    sessions,
    relationships,
    errors: [status, apps, proxies, serverNetworks, brokerStatusFetch, brokerNetworks, brokerForwards, proxyStatus].filter((item) => !item.ok),
    updatedAt: new Date(raw.collectedAt),
  };
}

function sessionsForApp(app) {
  const sessions = [];
  if (app.browserInstanceId || app.cdpUrl) {
    sessions.push({
      appId: app.id,
      sessionId: `${app.id}:default`,
      taskId: app.activeTask?.id,
      profile: app.profile,
      cdpUrl: app.cdpUrl,
      browserInstanceId: app.browserInstanceId,
      browserStartedAt: app.browserStartedAt,
      networkId: app.networkId,
      proxyId: app.proxyId,
      proxyForwardId: app.proxyForwardId,
      proxyServer: app.proxyServer,
      activeTask: app.activeTask,
      slot: 'default',
    });
  }
  for (const [sessionId, session] of Object.entries(app.browserSessions ?? {})) {
    sessions.push({
      appId: app.id,
      sessionId,
      ...session,
      slot: 'task',
    });
  }
  return sessions;
}

function computeRelationships({ apps, sessions, proxies, networks, proxyForwards, brokerStatus }) {
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
    add('profile', app.profile, `apps: ${app.id}`);
  }

  for (const session of sessions) {
    add('session', session.sessionId, `src app: ${session.appId}`);
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

function render(snapshot) {
  els.serverState.textContent = snapshot.serverOk ? 'Online' : 'Error';
  els.serverState.className = snapshot.serverOk ? 'good-text' : 'bad-text';

  const brokerReachable = Boolean(snapshot.brokerStatus);
  els.brokerState.textContent = brokerReachable ? brokerLabel(snapshot.brokerStatus) : 'Unreachable';
  els.brokerState.className = brokerReachable ? 'good-text' : 'bad-text';

  els.updatedAt.textContent = snapshot.updatedAt.toLocaleTimeString();

  setCount('overview', snapshot.errors.length + 4);
  setCount('apps', snapshot.apps.length);
  setCount('sessions', snapshot.sessions.length);
  setCount('networks', snapshot.networks.length);
  setCount('proxies', snapshot.proxies.length);

  renderOverview(snapshot);
  renderApps(snapshot.apps, snapshot.relationships);
  renderSessions(snapshot.sessions, snapshot.relationships);
  renderNetworks(snapshot.networks, snapshot.relationships);
  renderProxies(snapshot.proxies, snapshot.relationships);
}

function brokerLabel(status) {
  if (!status) return 'Reachable';
  const running = status.running ? 'running' : 'standby';
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

function renderOverview(snapshot) {
  const items = [
    {
      title: 'pw-dev server',
      badge: snapshot.serverOk ? badge('Online', 'good') : badge('Error', 'bad'),
      rows: {
        URL: snapshot.status.body?.serverUrl ?? state.pwDevUrl,
        Worktree: snapshot.status.body?.worktree,
        Root: snapshot.status.body?.root,
      },
    },
    {
      title: 'Broker',
      badge: snapshot.brokerStatus ? badge('Reachable', 'good') : badge('Unreachable', 'bad'),
      rows: {
        URL: snapshot.broker?.url ?? snapshot.brokerStatus?.url,
        Topology: snapshot.brokerStatus?.topology?.mode ?? 'unknown',
        Remote: snapshot.brokerStatus?.topology?.remote ? 'yes' : 'no',
        SSH: snapshot.brokerStatus?.topology?.ssh?.target ?? 'n/a',
        Instances: String(snapshot.brokerStatus?.instances?.length ?? 0),
        'Proxy forwards': String(snapshot.proxyForwards.length),
      },
    },
    {
      title: 'Proxy manager',
      badge: snapshot.proxyStatus.ok ? badge('Online', 'good') : badge('Unavailable', 'warn'),
      rows: {
        URL: snapshot.status.body?.proxy?.url,
        Error: snapshot.proxyStatus.ok ? undefined : snapshot.proxyStatus.error,
      },
    },
    {
      title: 'Counts',
      badge: badge('Snapshot', 'neutral'),
      rows: {
        Apps: String(snapshot.apps.length),
        Sessions: String(snapshot.sessions.length),
        Networks: String(snapshot.networks.length),
        Proxies: String(snapshot.proxies.length),
      },
    },
  ];

  if (snapshot.errors.length) {
    items.push({
      title: 'Fetch errors',
      badge: badge(String(snapshot.errors.length), 'warn'),
      rows: Object.fromEntries(snapshot.errors.map((error, index) => [
        `Error ${index + 1}`,
        `${error.url ?? error.path}: ${error.error}`,
      ])),
    });
  }
  renderCards(els.overview, items);
}

function renderApps(apps, relationships) {
  renderCards(els.apps, apps.map((app) => ({
    title: app.name ?? app.id,
    subtitle: app.id,
    badge: app.cdpUrl || app.browserSessions ? badge('Browser', 'good') : badge('Registered', 'neutral'),
    rows: {
      URL: app.appUrl,
      Branch: app.branch,
      Profile: app.profile,
      Network: app.networkId,
      Proxy: app.proxyId,
      Sessions: related(relationships, 'app', app.id),
      CDP: app.cdpUrl,
      Worktree: app.worktree,
    },
  })));
}

function renderSessions(sessions, relationships) {
  renderCards(els.sessions, sessions.map((session) => ({
    title: session.sessionId,
    subtitle: session.appId,
    badge: session.slot === 'task' ? badge('Task', 'neutral') : badge('Default', 'good'),
    rows: {
      Task: session.taskId,
      'Src app': session.appId,
      Owner: session.activeTask?.owner,
      Profile: session.profile,
      Network: session.networkId,
      Proxy: session.proxyId,
      'Proxy forward': session.proxyForwardId,
      Instance: session.browserInstanceId,
      Started: formatDate(session.browserStartedAt),
      CDP: session.cdpUrl,
      Related: related(relationships, 'session', session.sessionId),
    },
  })));
}

function renderNetworks(networks, relationships) {
  renderCards(els.networks, networks.map((network) => ({
    title: network.name ?? network.id,
    subtitle: network.id,
    badge: badge(network.proxy?.mode ?? 'network', network.proxy?.mode === 'ssh-peer' ? 'warn' : 'neutral'),
    rows: {
      Kind: network.kind,
      Owner: network.owner,
      Purpose: network.purpose,
      Server: network.proxy?.server,
      'Remote port': network.proxy?.remotePort,
      'Local port': network.proxy?.localPort,
      'Proxy server': network.resolved?.proxyServer,
      'Proxy forward': network.resolved?.proxyForwardId,
      'In use by': joinList(network.inUseBy),
      Related: related(relationships, 'network', network.id),
      Updated: formatDate(network.updatedAt),
    },
  })));
}

function renderProxies(proxies, relationships) {
  renderCards(els.proxies, proxies.map((proxy) => ({
    title: proxy.name ?? proxy.id,
    subtitle: proxy.id,
    badge: badge(proxy.managed ? 'Managed' : proxy.kind ?? 'Proxy', proxy.managed ? 'good' : 'neutral'),
    rows: {
      App: proxy.appId,
      Task: proxy.taskId,
      Owner: proxy.owner,
      Purpose: proxy.purpose,
      URL: proxy.proxyUrl,
      GUI: proxy.guiUrl,
      'Broker forward': proxy.brokerProxyForwardId,
      Labels: joinList(proxy.labels),
      Related: related(relationships, 'proxy', proxy.id),
      Updated: formatDate(proxy.updatedAt),
    },
  })));
}

function renderCards(root, cards) {
  root.replaceChildren();
  if (!cards.length) {
    root.appendChild(document.querySelector('#empty-template').content.cloneNode(true));
    return;
  }
  for (const card of cards) {
    const article = document.createElement('article');
    article.className = 'card';
    const head = document.createElement('div');
    head.className = 'card-head';
    const titleWrap = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = card.title;
    titleWrap.append(title);
    if (card.subtitle) {
      const subtitle = document.createElement('div');
      subtitle.className = 'id';
      subtitle.textContent = card.subtitle;
      titleWrap.append(subtitle);
    }
    head.append(titleWrap, card.badge ?? badge('Record', 'neutral'));
    article.append(head, rows(card.rows ?? {}));
    root.append(article);
  }
}

function rows(values) {
  const dl = document.createElement('dl');
  dl.className = 'kv';
  for (const [key, rawValue] of Object.entries(values)) {
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = String(rawValue);
    if (String(rawValue).includes('://') || key.toLowerCase().includes('id')) {
      dd.classList.add('mono');
    }
    dl.append(dt, dd);
  }
  if (!dl.children.length) {
    const dt = document.createElement('dt');
    dt.textContent = 'State';
    const dd = document.createElement('dd');
    dd.textContent = 'No details';
    dl.append(dt, dd);
  }
  return dl;
}

function badge(text, tone) {
  const span = document.createElement('span');
  span.className = `badge ${tone}`;
  span.textContent = text;
  return span;
}

function setCount(id, value) {
  document.querySelector(`#count-${id}`).textContent = String(value);
}

async function safeFetch(path) {
  try {
    const response = await fetch(path, { cache: 'no-store' });
    const body = await response.json().catch(() => undefined);
    return {
      ok: response.ok && body?.ok !== false,
      status: response.status,
      path,
      body,
      error: response.ok ? body?.error : body?.error ?? response.statusText,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      path,
      error: error?.message || 'request failed',
    };
  }
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return response.json();
}

function joinList(value) {
  if (!value) return undefined;
  if (Array.isArray(value)) return value.length ? value.join(', ') : undefined;
  return String(value);
}

function formatDate(value) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
