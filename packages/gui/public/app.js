const state = {
  timer: undefined,
  intervalMs: 5000,
  pwDevUrl: '',
  currentView: 'topology',
  last: undefined,
  visualizers: undefined,
  renderToken: 0,
  topologyRenderer: 'mermaid',
  topologySimulations: [],
};

const els = {
  target: document.querySelector('#target'),
  interval: document.querySelector('#interval'),
  refresh: document.querySelector('#refresh'),
  serverState: document.querySelector('#server-state'),
  brokerState: document.querySelector('#broker-state'),
  sessionsState: document.querySelector('#sessions-state'),
  updatedAt: document.querySelector('#updated-at'),
  topologyCards: document.querySelector('#topology-cards'),
  topologyContext: document.querySelector('#topology-context'),
  apps: document.querySelector('#apps-list'),
  broker: document.querySelector('#broker-list'),
  sessions: document.querySelector('#sessions-list'),
  networks: document.querySelector('#networks-list'),
  proxies: document.querySelector('#proxies-list'),
  rendererButtons: [...document.querySelectorAll('.toggle-btn')],
};

for (const button of document.querySelectorAll('.nav-item')) {
  button.addEventListener('click', () => showView(button.dataset.view));
}

for (const button of els.rendererButtons) {
  button.addEventListener('click', () => {
    const nextRenderer = button.dataset.renderer;
    if (!nextRenderer || nextRenderer === state.topologyRenderer) return;
    state.topologyRenderer = nextRenderer;
    syncRendererButtons();
    if (state.last) {
      void renderTopology(state.last, state.renderToken);
    }
  });
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
  els.target.textContent = 'agent-first dev scaffold';
  state.visualizers = await loadVisualizers();
  syncRendererButtons();
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

function showApp(appId) {
  showView('apps');
  const appCard = [...els.apps.querySelectorAll('[data-app-id]')]
    .find((card) => card.dataset.appId === appId);
  if (!appCard) return;
  appCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  appCard.focus({ preventScroll: true });
}

function showNetwork(networkId) {
  showView('networks');
  const networkCard = [...els.networks.querySelectorAll('[data-network-id]')]
    .find((card) => card.dataset.networkId === networkId);
  if (!networkCard) return;
  networkCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  networkCard.focus({ preventScroll: true });
}

function syncRendererButtons() {
  for (const button of els.rendererButtons) {
    button.classList.toggle('active', button.dataset.renderer === state.topologyRenderer);
  }
}

async function refresh() {
  els.refresh.disabled = true;
  try {
    const snapshot = normalizeSnapshot(await fetchJson('/api/snapshot'));
    state.last = snapshot;
    await render(snapshot);
  } finally {
    els.refresh.disabled = false;
  }
}

function normalizeSnapshot(raw) {
  const status = raw.server.status;
  const apps = raw.server.apps;
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
    : appList.flatMap((app) => sessionsForApp(app));
  const relationships = computeRelationships({ apps: appList, sessions, proxies: proxyList, networks: networkList, proxyForwards, brokerStatus });

  return {
    serverOk,
    status,
    broker: status.body?.broker,
    brokerStatus,
    brokers: brokerEntries,
    proxyStatus,
    apps: appList,
    proxies: proxyList,
    networks: networkList,
    proxyForwards,
    sessions,
    relationships,
    errors: [status, apps, serverSessions, proxies, serverNetworks, brokerStatusFetch, brokerNetworks, brokerForwards, proxyStatus, ...brokerEntries.map((entry) => entry.fetch)].filter((item) => !item.ok),
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

function sessionsForApp(app) {
  const sessions = [];
  if (app.browserInstanceId || app.cdpUrl) {
    sessions.push({
      appId: app.id,
      sessionId: `${app.id}:default`,
      taskId: app.activeTask?.id,
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

async function render(snapshot) {
  const token = ++state.renderToken;
  els.serverState.textContent = snapshot.serverOk ? 'Online' : 'Error';
  els.serverState.className = snapshot.serverOk ? 'good-text' : 'bad-text';

  const brokerReachable = snapshot.brokers.some((broker) => broker.status);
  els.brokerState.replaceChildren();
  for (const [index, broker] of snapshot.brokers.entries()) {
    const line = document.createElement('div');
    line.textContent = `${index + 1}: ${brokerLabel(broker.status)}`;
    line.className = `metric-status ${broker.status ? 'good-text' : 'bad-text'}`;
    els.brokerState.append(line);
  }
  if (!snapshot.brokers.length) els.brokerState.textContent = 'None';
  els.brokerState.className = brokerReachable ? 'good-text' : 'bad-text';

  els.sessionsState.textContent = `${snapshot.sessions.length} active`;
  els.sessionsState.className = snapshot.sessions.length ? 'good-text' : 'good-text';

  els.updatedAt.textContent = snapshot.updatedAt.toLocaleTimeString();

  setCount('topology', topologyFlowCount(snapshot));
  setCount('apps', snapshot.apps.length);
  setCount('broker', snapshot.brokers.length);
  setCount('sessions', snapshot.sessions.length);
  setCount('networks', snapshot.networks.length);
  setCount('proxies', snapshot.proxies.length);

  await renderTopology(snapshot, token);
  if (token !== state.renderToken) return;
  renderApps(snapshot.apps, snapshot.relationships);
  renderBroker(snapshot);
  renderSessions(snapshot.sessions, snapshot.relationships);
  renderNetworks(snapshot.networks, snapshot.relationships);
  renderProxies(snapshot.proxies, snapshot.relationships);
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

async function renderTopology(snapshot, token) {
  disposeTopologySimulations();
  const contexts = buildTopologyContexts(snapshot);
  els.topologyCards.replaceChildren();

  if (!contexts.length) {
    els.topologyCards.append(emptyState('No registered apps are present in this snapshot.'));
  } else {
    for (const context of contexts) {
      const card = document.createElement('article');
      card.className = `card topology-card topology-flow-${context.sessions.length ? 'active' : 'idle'}`;

      const head = document.createElement('div');
      head.className = 'card-head';
      const titleWrap = document.createElement('div');
      const title = document.createElement('h3');
      title.textContent = context.app.name ?? context.app.id;
      const subtitle = document.createElement('div');
      subtitle.className = 'id';
      subtitle.textContent = context.app.id;
      titleWrap.append(title, subtitle);

      const badgeRow = document.createElement('div');
      badgeRow.className = 'badge-row';
      badgeRow.append(
        badgeElement(context.sessions.length ? `${context.sessions.length} sessions` : 'No session', context.sessions.length ? 'good' : 'neutral'),
        badgeElement(context.proxies.length ? `${context.proxies.length} proxies` : 'No proxy', context.proxies.length ? 'good' : 'neutral'),
        badgeElement(context.networks.length ? `${context.networks.length} networks` : 'No network', context.networks.length ? 'warn' : 'neutral')
      );
      head.append(titleWrap, badgeRow);

      const graph = buildTopologyGraph(snapshot, context);
      const surface = document.createElement('div');
      surface.className = 'topology-surface';
      if (state.topologyRenderer === 'd3') {
        const simulation = renderD3Graph(surface, graph);
        if (simulation) state.topologySimulations.push(simulation);
      } else {
        await renderMermaidGraph(surface, graph, token);
        if (token !== state.renderToken) return;
      }

      const summaryTitle = document.createElement('h4');
      summaryTitle.className = 'topology-subtitle';
      summaryTitle.textContent = 'Active wiring';
      const summaryList = document.createElement('ul');
      summaryList.className = 'topology-summary';
      if (context.flows.length) {
        for (const flow of context.flows) {
          const item = document.createElement('li');
          item.textContent = flow.summary;
          summaryList.append(item);
        }
      } else {
        const item = document.createElement('li');
        item.textContent = `app ${context.app.id} is registered but has no active session, proxy, or network wiring.`;
        summaryList.append(item);
      }

      card.append(head, surface, summaryTitle, summaryList);
      els.topologyCards.append(card);
    }
  }

  await renderMarkdown(els.topologyContext, buildSnapshotMarkdown(snapshot), token);
}

function renderApps(apps, relationships) {
  renderCards(els.apps, apps.map((app) => ({
    appId: app.id,
    title: app.name ?? app.id,
    subtitle: app.id,
    badge: app.cdpUrl || app.browserSessions ? badge('Browser', 'good') : badge('Registered', 'neutral'),
    rows: {
      URL: app.appUrl,
      Branch: app.branch,
      Network: app.networkId,
      Proxy: app.proxyId,
      Sessions: related(relationships, 'app', app.id),
      CDP: app.cdpUrl,
      Worktree: app.worktree,
    },
  })));
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

function renderSessions(sessions, relationships) {
  renderCards(els.sessions, sessions.map((session) => ({
    title: session.sessionId,
    subtitle: session.appId,
    badge: session.slot === 'task' ? badge('Task', 'neutral') : badge('Default', 'good'),
    rows: {
      Task: session.taskId,
      'Related src app': appLink(session.appId),
      Owner: session.activeTask?.owner,
      Profile: session.profile,
      Network: session.networkId,
      Proxy: session.proxyId,
      'SSH proxy mapping': session.proxyForwardId ? 'active' : undefined,
      'Proxy forward': session.proxyForwardId,
      Instance: session.browserInstanceId,
      Started: formatDate(session.browserStartedAt),
      CDP: session.cdpUrl,
      Related: related(relationships, 'session', session.sessionId),
    },
  })));
}

function appLink(appId) {
  return {
    link: true,
    text: appId,
    href: '#apps',
    onClick: () => showApp(appId),
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

function renderProxies(proxies, relationships) {
  renderCards(els.proxies, proxies.map((proxy) => ({
    title: proxy.name ?? proxy.id,
    subtitle: proxy.id,
    badge: badge(proxy.running === true ? 'Running' : proxy.running === false ? 'Stopped' : proxy.managed ? 'Managed' : proxy.kind ?? 'Proxy', proxy.running === true ? 'good' : proxy.running === false ? 'bad' : 'neutral'),
    rows: {
      App: proxy.appId,
      Status: proxy.running === true ? 'Running' : proxy.running === false ? 'Stopped' : 'Unknown',
      Task: proxy.taskId,
      Owner: proxy.owner,
      Purpose: proxy.purpose,
      URL: proxy.proxyUrl,
      GUI: proxy.guiUrl ? {
        link: true,
        text: proxy.guiUrl,
        href: `/proxy/${encodeURIComponent(proxy.id)}/gui/`,
        onClick: () => window.open(
          `/proxy/${encodeURIComponent(proxy.id)}/gui/`,
          '_blank',
          'noopener,noreferrer'
        ),
      } : undefined,
      'Broker forward': proxy.brokerProxyForwardId,
      Labels: joinList(proxy.labels),
      Related: related(relationships, 'proxy', proxy.id),
      Updated: formatDate(proxy.updatedAt),
    },
  })));
}

async function loadVisualizers() {
  const results = await Promise.allSettled([
    import('https://cdn.jsdelivr.net/npm/marked/lib/marked.esm.js'),
    import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'),
    import('https://cdn.jsdelivr.net/npm/d3@7/+esm'),
  ]);

  const visualizers = {};
  const [markedResult, mermaidResult, d3Result] = results;

  if (markedResult.status === 'fulfilled') {
    const { marked } = markedResult.value;
    marked.setOptions({ gfm: true, breaks: true });
    visualizers.marked = marked;
  } else {
    console.warn('Failed to load marked renderer', markedResult.reason);
  }

  if (mermaidResult.status === 'fulfilled') {
    const mermaid = mermaidResult.value.default ?? mermaidResult.value;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      theme: 'neutral',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      themeVariables: {
        fontSize: '6px',
      },
    });
    visualizers.mermaid = mermaid;
  } else {
    console.warn('Failed to load mermaid renderer', mermaidResult.reason);
  }

  if (d3Result.status === 'fulfilled') {
    visualizers.d3 = d3Result.value;
  } else {
    console.warn('Failed to load d3 renderer', d3Result.reason);
  }

  return visualizers;
}

async function renderMarkdown(root, markdown, token) {
  if (!state.visualizers?.marked) {
    root.replaceChildren();
    const fallback = document.createElement('pre');
    fallback.className = 'markdown-fallback';
    fallback.textContent = markdown;
    root.append(fallback);
    return;
  }

  root.innerHTML = state.visualizers.marked.parse(markdown);
  const mermaidBlocks = [...root.querySelectorAll('code.language-mermaid')];
  for (const [index, code] of mermaidBlocks.entries()) {
    if (token !== state.renderToken) return;
    const pre = code.parentElement;
    if (!pre) continue;
    const host = document.createElement('div');
    host.className = 'mermaid-host';
    pre.replaceWith(host);
    try {
      const id = `pw-dev-topology-${token}-${index}`;
      const { svg } = await state.visualizers.mermaid.render(id, code.textContent);
      if (token !== state.renderToken) return;
      host.innerHTML = svg;
    } catch (error) {
      host.textContent = `Mermaid render failed: ${error.message}`;
      host.classList.add('mermaid-error');
    }
  }
}

function buildSnapshotMarkdown(snapshot) {
  const lines = [
    '### Snapshot Context',
    '',
    `- pw-dev server: ${snapshot.status.body?.serverUrl ?? state.pwDevUrl}`,
    `- broker topology: ${brokerLabel(snapshot.brokerStatus)}`,
    `- managed proxies: ${snapshot.proxies.length}`,
    `- broker sessions: ${snapshot.sessions.length}`,
  ];

  if (snapshot.errors.length) {
    lines.push('', '### Fetch Warnings', '');
    for (const error of snapshot.errors) {
      lines.push(`- ${error.url ?? error.path}: ${error.error}`);
    }
  }

  return lines.join('\n');
}

function buildTopologyContexts(snapshot) {
  const proxyById = new Map(snapshot.proxies.map((proxy) => [proxy.id, proxy]));
  const networkById = new Map(snapshot.networks.map((network) => [network.id, network]));
  return snapshot.apps.map((app) => {
    const sessions = snapshot.sessions.filter((session) => session.appId === app.id);
    const networkIds = new Set([
      app.networkId,
      ...sessions.map((session) => session.networkId),
    ].filter(Boolean));
    const networks = [...networkIds].map((id) => networkById.get(id)).filter(Boolean);
    const flowSeed = sessions.length ? sessions : [undefined];
    const flows = flowSeed.map((session) => {
      const network = session ? networkById.get(session.networkId ?? app.networkId) : networkById.get(app.networkId);
      const proxyCandidates = selectFlowProxies({
        app,
        session,
        network,
        proxies: snapshot.proxies,
        proxyById,
      });
      return {
        app,
        session,
        network,
        proxies: proxyCandidates,
        summary: summarizeFlow({ app, session, network, proxies: proxyCandidates }),
      };
    });

    const proxies = new Map();
    for (const flow of flows) {
      for (const proxy of flow.proxies) proxies.set(proxy.id, proxy);
    }
    for (const proxy of snapshot.proxies) {
      if (proxy.appId === app.id) proxies.set(proxy.id, proxy);
    }

    return {
      app,
      sessions,
      networks,
      proxies: [...proxies.values()],
      flows,
    };
  });
}

function buildTopologyGraph(snapshot, context) {
  const nodeRegistry = new Map();
  const edges = [];
  const seenEdges = new Set();

  const addNode = (kind, key, label, tone) => {
    if (!key) return undefined;
    const entityKey = `${kind}:${key}`;
    const existing = nodeRegistry.get(entityKey);
    if (existing) {
      existing.labels.add(label);
      return existing.id;
    }
    const node = {
      id: mermaidNodeId(kind, key),
      kind,
      tone,
      labels: new Set([label]),
    };
    nodeRegistry.set(entityKey, node);
    return node.id;
  };
  const addEdge = (from, to, label, style = 'solid', bidirectional = false) => {
    if (!from || !to) return;
    const key = `${from}|${to}|${label}|${style}|${bidirectional}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ from, to, label, style, bidirectional });
  };

  const brokerNode = addNode(
    'broker',
    canonicalBrokerKey(snapshot.brokerStatus),
    formatBrokerNodeLabel(snapshot, context.sessions),
    'broker-node'
  );

  const app = context.app;
  const appNode = addNode('app', canonicalAppKey(app), formatAppNodeLabel(app, context.sessions), 'app-node');
  for (const proxy of context.proxies) {
    addNode(
      'proxy',
      canonicalProxyKey(proxy),
      formatProxyNodeLabel(proxy),
      'proxy-node'
    );
  }

  for (const network of context.networks) {
    addNode(
      'network',
      canonicalNetworkKey(network),
      `Network\n${network.id}\n${formatNetworkLabel(network)}`,
      'network-node'
    );
  }

  for (const flow of context.flows) {
    const networkNode = flow.network
      ? addNode('network', canonicalNetworkKey(flow.network), `Network\n${flow.network.id}\n${formatNetworkLabel(flow.network)}`, 'network-node')
      : undefined;

    const flowStyle = flow.session ? 'solid' : 'dotted';
    const bidirectional = Boolean(flow.session);
    let previousNode = appNode;
    for (const proxy of flow.proxies) {
      const proxyNode = addNode(
        'proxy',
        canonicalProxyKey(proxy),
        formatProxyNodeLabel(proxy),
        'proxy-node'
      );
      addEdge(previousNode, proxyNode, undefined, flowStyle, bidirectional);
      previousNode = proxyNode;
    }

    if (networkNode) {
      addEdge(previousNode, networkNode, undefined, flowStyle, bidirectional);
      previousNode = networkNode;
    }
    addEdge(previousNode, brokerNode, undefined, flowStyle, bidirectional);
  }

  return {
    nodes: [...nodeRegistry.values()].map((node) => ({
      ...node,
      label: mergeNodeLabels(node.labels),
    })),
    edges,
  };
}

async function renderMermaidGraph(root, graph, token) {
  if (!state.visualizers?.mermaid) {
    root.replaceChildren(fallbackMessage('Mermaid renderer unavailable.'));
    return;
  }

  const host = document.createElement('div');
  host.className = 'mermaid-host';
  root.replaceChildren(host);
  try {
    const id = `pw-dev-topology-${token}-${Math.random().toString(36).slice(2, 8)}`;
    const { svg } = await state.visualizers.mermaid.render(id, buildMermaidDiagram(graph));
    if (token !== state.renderToken) return;
    host.innerHTML = svg;
  } catch (error) {
    host.textContent = `Mermaid render failed: ${error.message}`;
    host.classList.add('mermaid-error');
  }
}

function renderD3Graph(root, graph) {
  if (!state.visualizers?.d3) {
    root.replaceChildren(fallbackMessage('D3 renderer unavailable.'));
    return undefined;
  }

  const d3 = state.visualizers.d3;
  const container = document.createElement('div');
  container.className = 'd3-host';
  root.replaceChildren(container);

  const width = 1100;
  const height = Math.max(520, 180 + graph.nodes.length * 56);
  const nodeBox = { width: 192, height: 74, radius: 18 };
  const nodes = graph.nodes.map((node) => ({ ...node }));
  const links = graph.edges.map((edge) => ({ ...edge }));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const layoutIndex = buildD3LayoutIndex(nodes);
  for (const link of links) {
    link.source = nodeById.get(link.from);
    link.target = nodeById.get(link.to);
  }

  for (const node of nodes) {
    node.x = xTargetForNode(node, width);
    node.y = yTargetForNode(node, layoutIndex, height);
  }

  const color = {
    'dev-node': '#f6c344',
    'app-node': '#4f87c5',
    'proxy-node': '#24a061',
    'network-node': '#d58b29',
    'broker-node': '#6d7a89',
    'session-node': '#8d60d1',
  };
  const stroke = {
    'dev-node': '#9d7000',
    'app-node': '#214d7d',
    'proxy-node': '#15603b',
    'network-node': '#8d4f05',
    'broker-node': '#35414d',
    'session-node': '#5b35a6',
  };
  const markerId = `pw-dev-arrow-${Math.random().toString(36).slice(2, 8)}`;

  const svg = d3.create('svg')
    .attr('viewBox', [0, 0, width, height].join(' '))
    .attr('aria-label', 'Topology graph');

  const defs = svg.append('defs');
  defs.append('marker')
    .attr('id', markerId)
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 12)
    .attr('refY', 0)
    .attr('markerWidth', 7)
    .attr('markerHeight', 7)
    .attr('orient', 'auto-start-reverse')
    .append('path')
    .attr('d', 'M0,-5L10,0L0,5')
    .attr('fill', '#708090');

  const scene = svg.append('g');
  const zoom = d3.zoom()
    .scaleExtent([0.5, 1.8])
    .on('zoom', (event) => {
      scene.attr('transform', event.transform);
    });
  svg.call(zoom);

  const link = scene.append('g')
    .attr('class', 'd3-links')
    .selectAll('g')
    .data(links)
    .join('g');

  const linkPath = link.append('path')
    .attr('fill', 'none')
    .attr('stroke', '#9eabb8')
    .attr('stroke-width', (edge) => edge.bidirectional ? 3 : 1.8)
    .attr('stroke-dasharray', (edge) => edge.style === 'dotted' ? '5 5' : undefined)
    .attr('stroke-linecap', 'round')
    .attr('marker-end', `url(#${markerId})`)
    .attr('marker-start', (edge) => edge.bidirectional ? `url(#${markerId})` : undefined);

  const linkLabel = link.append('text')
    .attr('class', 'd3-edge-label')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .text((edge) => edge.label);

  const node = scene.append('g')
    .attr('class', 'd3-nodes')
    .selectAll('g')
    .data(nodes)
    .join('g')
    .attr('class', 'd3-node')
    .call(d3.drag()
      .on('start', dragStarted)
      .on('drag', dragged)
      .on('end', dragEnded));

  node.append('rect')
    .attr('x', -(nodeBox.width / 2))
    .attr('y', -(nodeBox.height / 2))
    .attr('width', nodeBox.width)
    .attr('height', nodeBox.height)
    .attr('rx', nodeBox.radius)
    .attr('fill', (item) => color[item.tone] ?? '#d7dee6')
    .attr('fill-opacity', 0.16)
    .attr('stroke', (item) => stroke[item.tone] ?? '#52606d')
    .attr('stroke-width', 2);

  node.append('text')
    .attr('class', 'd3-node-label')
    .attr('text-anchor', 'middle')
    .selectAll('tspan')
    .data((item) => item.label.split('\n').slice(0, 4).map((line, index) => ({ line, index })))
    .join('tspan')
    .attr('x', 0)
    .attr('y', ({ index }) => -12 + index * 15)
    .text(({ line }) => line);

  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id((item) => item.id).distance(220).strength(0.7))
    .force('charge', d3.forceManyBody().strength(-1450))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collide', d3.forceCollide().radius(Math.max(nodeBox.width, nodeBox.height)))
    .force('x', d3.forceX((item) => xTargetForNode(item, width)).strength(0.32))
    .force('y', d3.forceY((item) => yTargetForNode(item, layoutIndex, height)).strength(0.16))
    .on('tick', ticked);

  ticked();
  container.append(svg.node());

  function ticked() {
    link.each((edge) => {
      edge.geometry = d3LinkPath(edge, nodeBox);
    });

    linkPath.attr('d', (edge) => edge.geometry.path);

    linkLabel
      .attr('x', (edge) => edge.geometry.label.x)
      .attr('y', (edge) => edge.geometry.label.y);

    node.attr('transform', (item) => `translate(${item.x},${item.y})`);
  }

  function dragStarted(event) {
    if (!event.active) simulation.alphaTarget(0.2).restart();
    event.subject.fx = event.subject.x;
    event.subject.fy = event.subject.y;
  }

  function dragged(event) {
    event.subject.fx = event.x;
    event.subject.fy = event.y;
  }

  function dragEnded(event) {
    if (!event.active) simulation.alphaTarget(0);
    event.subject.fx = null;
    event.subject.fy = null;
  }

  return simulation;
}

function buildD3LayoutIndex(nodes) {
  const grouped = new Map();
  for (const node of nodes) {
    if (!grouped.has(node.kind)) grouped.set(node.kind, []);
    grouped.get(node.kind).push(node);
  }
  const index = new Map();
  for (const [kind, group] of grouped.entries()) {
    group.sort((left, right) => left.label.localeCompare(right.label));
    group.forEach((node, position) => {
      index.set(node.id, { kind, position, total: group.length });
    });
  }
  return index;
}

function xTargetForNode(node, width) {
  const laneOrder = ['dev', 'app', 'proxy', 'network', 'broker', 'session'];
  const laneIndex = Math.max(0, laneOrder.indexOf(node.kind));
  return ((laneIndex + 1) / (laneOrder.length + 1)) * width;
}

function yTargetForNode(node, layoutIndex, height) {
  const layout = layoutIndex.get(node.id);
  if (!layout || layout.total <= 1) return height / 2;
  const top = 96;
  const bottom = height - 96;
  const span = bottom - top;
  return top + (layout.position * span) / (layout.total - 1);
}

function d3LinkPath(edge, nodeBox) {
  const start = d3NodeAnchor(edge.source, edge.target, nodeBox);
  const end = d3NodeAnchor(edge.target, edge.source, nodeBox);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy) || 1;
  const normalX = -dy / distance;
  const normalY = dx / distance;
  const curveSign = d3CurveSign(edge, dx, dy);
  const curveOffset = Math.min(70, Math.max(28, distance * 0.16)) * curveSign;
  const control = {
    x: (start.x + end.x) / 2 + normalX * curveOffset,
    y: (start.y + end.y) / 2 + normalY * curveOffset,
  };
  const midpoint = d3QuadraticPoint(start, control, end, 0.5);
  return {
    path: `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`,
    label: {
      x: midpoint.x + normalX * curveSign * 12,
      y: midpoint.y + normalY * curveSign * 12,
    },
  };
}

function d3NodeAnchor(source, target, nodeBox) {
  const halfWidth = nodeBox.width / 2;
  const halfHeight = nodeBox.height / 2;
  const dx = (target.x ?? source.x) - (source.x ?? 0);
  const dy = (target.y ?? source.y) - (source.y ?? 0);
  if (!dx && !dy) {
    return { x: source.x ?? 0, y: source.y ?? 0 };
  }
  const scale = Math.max(Math.abs(dx) / halfWidth, Math.abs(dy) / halfHeight);
  return {
    x: source.x + dx / scale,
    y: source.y + dy / scale,
  };
}

function d3CurveSign(edge, dx, dy) {
  if (Math.abs(dy) > 24) return dy > 0 ? -1 : 1;
  return hashString(`${edge.from}|${edge.to}|${edge.label}`) % 2 === 0 ? -1 : 1;
}

function d3QuadraticPoint(start, control, end, t) {
  const inverse = 1 - t;
  return {
    x: (inverse * inverse * start.x) + (2 * inverse * t * control.x) + (t * t * end.x),
    y: (inverse * inverse * start.y) + (2 * inverse * t * control.y) + (t * t * end.y),
  };
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function disposeTopologySimulations() {
  for (const simulation of state.topologySimulations) {
    simulation.stop();
  }
  state.topologySimulations = [];
}

function buildMermaidDiagram(graph) {
  const nodes = graph.nodes.map((node) => (
    `  ${node.id}["${escapeMermaidLabel(node.label)}"]`
  ));
  const edges = graph.edges.map((edge) => {
    if (edge.style === 'dotted') {
      return edge.label
        ? `  ${edge.from} -. ${escapeMermaidLabel(edge.label)} .-> ${edge.to}`
        : `  ${edge.from} -.-> ${edge.to}`;
    }
    if (edge.bidirectional) {
      return edge.label
        ? `  ${edge.from} <==>|${escapeMermaidLabel(edge.label)}| ${edge.to}`
        : `  ${edge.from} <==> ${edge.to}`;
    }
    return edge.label
      ? `  ${edge.from} -->|${escapeMermaidLabel(edge.label)}| ${edge.to}`
      : `  ${edge.from} --> ${edge.to}`;
  });
  const classes = graph.nodes.map((node) => `  class ${node.id} ${node.tone};`);

  return [
    'flowchart LR',
    ...nodes,
    '',
    ...edges,
    '',
    '  classDef dev-node fill:#fff2cc,stroke:#c89b00,color:#5b4100;',
    '  classDef app-node fill:#e7f0ff,stroke:#386cb0,color:#12314f;',
    '  classDef proxy-node fill:#e7f7ef,stroke:#17824d,color:#0f4a2d;',
    '  classDef network-node fill:#fff4e5,stroke:#cc7a00,color:#6a3a00;',
    '  classDef broker-node fill:#eef0f4,stroke:#49586b,color:#1c2630;',
    '  classDef session-node fill:#f3ebff,stroke:#7a4fc2,color:#41216f;',
    ...classes,
  ].join('\n');
}

function mergeNodeLabels(labels) {
  const values = [...labels];
  if (values.length <= 1) return values[0] ?? '';
  return values.join('\n---\n');
}

function selectFlowProxies({ app, session, network, proxies, proxyById }) {
  const selected = new Map();
  const add = (proxy) => {
    if (proxy?.id) selected.set(proxy.id, proxy);
  };

  add(proxyById.get(session?.proxyId));
  add(proxyById.get(app?.proxyId));

  if (network) {
    for (const proxy of proxies) {
      if (proxyMatchesNetwork(proxy, network)) add(proxy);
    }
  }

  return [...selected.values()];
}

function proxyMatchesNetwork(proxy, network) {
  if (!proxy?.proxyUrl || !network?.proxy) return false;
  const proxyPort = portFromUrl(proxy.proxyUrl);
  if (network.proxy.mode === 'direct' || network.proxy.mode === 'broker-local') {
    return network.proxy.server === proxy.proxyUrl;
  }
  if (network.proxy.mode === 'ssh-peer') {
    return proxyPort !== undefined && proxyPort === network.proxy.remotePort;
  }
  if (network.resolved?.proxyForwardId && proxy.brokerProxyForwardId) {
    return network.resolved.proxyForwardId === proxy.brokerProxyForwardId;
  }
  return false;
}

function summarizeFlow({ app, session, network, proxies }) {
  const parts = [];
  if (app) {
    parts.push(`app ${app.id}`);
  }
  if (proxies.length) {
    parts.push(`proxy ${proxies.map((proxy) => proxy.id).join(' + ')}`);
  }
  if (network) {
    parts.push(`network ${network.id} (${formatNetworkLabel(network)})`);
  }
  if (session) {
    parts.push(`session ${session.sessionId}`);
  }
  return parts.join(' -> ');
}

function topologyFlowCount(snapshot) {
  return snapshot.apps.length || 1;
}

function formatAppNodeLabel(app, sessions = []) {
  const endpoint = app.appUrl ?? 'no app URL';
  const sessionLabel = sessions.length ? `\nSession: app ⇔ browser` : '';
  return `App\n${app.id}\n${endpoint}${sessionLabel}`;
}

function formatProxyNodeLabel(proxy) {
  const stateLabel = proxy.running === true ? 'running' : proxy.running === false ? 'stopped' : 'unknown';
  return `Proxy\n${proxy.id}\n${proxy.proxyUrl ?? proxy.brokerProxyForwardId ?? 'no proxyUrl'}\n${stateLabel}`;
}

function formatNetworkLabel(network) {
  if (!network?.proxy) return 'no proxy config';
  if (network.proxy.mode === 'ssh-peer') {
    const local = network.proxy.localPort ?? portFromUrl(network.resolved?.proxyServer);
    return `ssh-peer ${network.proxy.remotePort}${local ? ` -> ${local}` : ''}`;
  }
  if (network.proxy.mode === 'direct' || network.proxy.mode === 'broker-local') {
    return `${network.proxy.mode} ${network.proxy.server}`;
  }
  return network.proxy.mode;
}

function networkProxyLabel(network, proxy) {
  if (!network?.proxy) return 'network';
  if (network.proxy.mode === 'ssh-peer') {
    const localPort = network.proxy.localPort ?? portFromUrl(network.resolved?.proxyServer);
    return `${proxy.proxyUrl} | ${network.proxy.remotePort}${localPort ? ` -> ${localPort}` : ''}`;
  }
  if (network.proxy.server) return network.proxy.server;
  return network.proxy.mode;
}

function portFromUrl(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.port ? Number(url.port) : undefined;
  } catch {
    return undefined;
  }
}

function mermaidNodeId(prefix, value) {
  return `${prefix}_${String(value).replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function canonicalAppKey(app) {
  if (app?.appUrl || app?.worktree || app?.profile) {
    return `app:${app?.appUrl ?? ''}:${app?.worktree ?? ''}:${app?.profile ?? ''}`;
  }
  return `id:${app?.id ?? ''}`;
}

function canonicalProxyKey(proxy) {
  if (proxy?.proxyUrl || proxy?.brokerProxyForwardId) {
    return `proxy:${proxy?.proxyUrl ?? ''}:${proxy?.brokerProxyForwardId ?? ''}`;
  }
  return `id:${proxy?.id ?? ''}`;
}

function canonicalNetworkKey(network) {
  if (network?.proxy || network?.resolved) {
    return `network:${network?.proxy?.mode ?? ''}:${network?.proxy?.server ?? ''}:${network?.proxy?.remotePort ?? ''}:${network?.proxy?.localPort ?? ''}:${network?.resolved?.proxyForwardId ?? ''}:${network?.resolved?.proxyServer ?? ''}`;
  }
  return `id:${network?.id ?? ''}`;
}

function canonicalSessionKey(session) {
  if (session?.browserInstanceId) return `instance:${session.browserInstanceId}`;
  if (session?.cdpUrl) return `cdp:${session.cdpUrl}`;
  return `session:${session?.sessionId ?? ''}:${session?.appId ?? ''}:${session?.profile ?? ''}`;
}

function canonicalBrokerKey(status) {
  return `broker:${status?.topology?.mode ?? 'unknown'}:${status?.topology?.remote ? 'remote' : 'local'}:${status?.topology?.ssh?.target ?? ''}`;
}

function formatBrokerNodeLabel(snapshot, sessions = []) {
  const status = snapshot.brokerStatus;
  if (!status) return 'Broker\nunreachable';
  const lines = ['Broker'];
  lines.push(status.topology?.mode ? `${status.topology.mode}${status.topology?.remote ? ' remote' : ''}` : 'reachable');
  if (sessions.length) lines.push('Session: app ⇔ browser');
  if (status.instances?.length) lines.push(`${status.instances.length} browser${status.instances.length === 1 ? '' : 's'}`);
  if (status.topology?.ssh?.target) lines.push(status.topology.ssh.target);
  const remoteMachine = status.topology?.ssh?.remoteMachine;
  if (remoteMachine?.hostname) lines.push(remoteMachine.hostname);
  if (remoteMachine?.addresses?.length) lines.push(remoteMachine.addresses.join(', '));
  if (remoteMachine?.platform || remoteMachine?.release) {
    lines.push([remoteMachine.platform, remoteMachine.release].filter(Boolean).join(' '));
  }
  if (status.state === 'idle') lines.push('idle');
  return lines.join('\n');
}

function escapeMermaidLabel(value) {
  return String(value ?? '')
    .replace(/"/g, '&quot;')
    .replace(/\|/g, '/')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
        link.addEventListener('click', (event) => {
          event.preventDefault();
          value.onClick();
        });
        dd.append(link);
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

function emptyState(message = 'No records') {
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent = message;
  return empty;
}

function fallbackMessage(message) {
  const node = document.createElement('div');
  node.className = 'mermaid-error';
  node.textContent = message;
  return node;
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
