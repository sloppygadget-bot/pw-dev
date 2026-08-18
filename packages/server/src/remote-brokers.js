import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REMOTE_REPOSITORY = 'https://github.com/sloppygadget-bot/pw-dev.git';
const DEFAULT_REMOTE_WORKTREE = '.pw-dev/pw-dev';
const DEFAULT_REMOTE_PORT = 18080;
const LOCAL_PORT_START = 18080;
const LOCAL_PORT_END = 18089;
const RECONNECT_INITIAL_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const HEALTH_CHECK_INTERVAL_MS = 10_000;
const SSH_CONTROL_PERSIST = '24h';
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

const REMOTE_BOOTSTRAP_SCRIPT = String.raw`set -eu
repository=$1
worktree=$2
remote_port=$3
desired_revision=$4

case "$worktree" in
  /*) ;;
  *) worktree="$HOME/$worktree" ;;
esac

case "$remote_port" in
  *[!0-9]*|'') echo "remote broker port must be numeric" >&2; exit 2 ;;
esac

if [ "$remote_port" -lt 1 ] || [ "$remote_port" -gt 65535 ]; then
  echo "remote broker port must be between 1 and 65535" >&2
  exit 2
fi

node_major() {
  node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true
}

if [ "$(node_major)" -lt 18 ] 2>/dev/null; then
  nvm_dir=$(printenv NVM_DIR 2>/dev/null || true)
  user_home=$(getent passwd "$(id -un)" 2>/dev/null | awk -F: 'NR == 1 { print $6 }')
  if [ -z "$user_home" ]; then user_home="$HOME"; fi
  if [ -z "$nvm_dir" ] || [ ! -s "$nvm_dir/nvm.sh" ]; then nvm_dir="$user_home/.nvm"; fi
  # The nvm installer and install command read optional environment variables.
  # Temporarily permit those variables to be absent despite this script's -u.
  set +u
  export NVM_DIR="$nvm_dir"
  if [ ! -s "$nvm_dir/nvm.sh" ]; then
    if ! command -v curl >/dev/null 2>&1; then
      echo "remote broker requires Node.js 18+ and NVM is missing; curl is required to install NVM" >&2
      exit 2
    fi
    PROFILE=/dev/null NVM_DIR="$nvm_dir" bash -c "$(curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh)"
  fi
  . "$nvm_dir/nvm.sh"
  if ! nvm use --silent 18 >/dev/null 2>&1; then
    nvm install 18 >/dev/null
    nvm use --silent 18 >/dev/null
  fi
  set -u
fi

if [ "$(node_major)" -lt 18 ] 2>/dev/null; then
  echo "remote broker requires Node.js 18+" >&2
  exit 2
fi

probe() {
  node -e '
    const http = require("http");
    const request = http.get("http://127.0.0.1:" + process.argv[1] + "/_broker/status", (response) => {
      response.resume();
      response.on("end", () => process.exit(response.statusCode >= 200 && response.statusCode < 300 ? 0 : 1));
    });
    request.on("error", () => process.exit(1));
    request.setTimeout(1000, () => request.destroy());
  ' "$remote_port"
}

pid_file="$worktree/.pw-dev-broker-$remote_port.pid"
stop_managed_broker() {
  if [ ! -s "$pid_file" ]; then
    echo "healthy remote broker needs an update but is not managed by pw-dev: $pid_file is missing" >&2
    exit 3
  fi
  pid=$(cat "$pid_file")
  case "$pid" in
    *[!0-9]*|'') echo "invalid remote broker pid file: $pid_file" >&2; exit 3 ;;
  esac
  if kill -0 "$pid" 2>/dev/null; then
    command=$(ps -p "$pid" -o args= 2>/dev/null || true)
    case "$command" in
      *"$worktree/packages/cdp-broker/bin/pw-cdp-broker.js"*) ;;
      *) echo "pid $pid is not the pw-dev broker in $worktree" >&2; exit 3 ;;
    esac
    kill -TERM "$pid"
    attempts=0
    while kill -0 "$pid" 2>/dev/null; do
      attempts=$((attempts + 1))
      if [ "$attempts" -ge 10 ]; then
        echo "remote broker pid $pid did not stop" >&2
        exit 1
      fi
      sleep 1
    done
  fi
  rm -f "$pid_file"
}

started=false
updated=false
if [ -e "$worktree" ] && [ ! -d "$worktree/.git" ]; then
  echo "remote worktree exists but is not a git checkout: $worktree" >&2
  exit 2
fi

if [ ! -d "$worktree/.git" ]; then
  mkdir -p "$(dirname "$worktree")"
  git clone --depth 1 "$repository" "$worktree"
fi

current_revision=$(git -C "$worktree" rev-parse HEAD)
if [ "$current_revision" != "$desired_revision" ]; then
  if ! git -C "$worktree" diff --quiet || ! git -C "$worktree" diff --cached --quiet; then
    echo "remote pw-dev checkout differs from server revision and has local changes: $worktree" >&2
    exit 3
  fi
  if probe; then
    stop_managed_broker
  fi
  git -C "$worktree" fetch --depth 1 origin "$desired_revision"
  git -C "$worktree" checkout --detach FETCH_HEAD
  current_revision=$(git -C "$worktree" rev-parse HEAD)
  updated=true
fi

if ! probe; then
  log="$worktree/.pw-dev-broker-$remote_port.log"
  nohup node "$worktree/packages/cdp-broker/bin/pw-cdp-broker.js" \
    --standby --host 127.0.0.1 --port "$remote_port" >"$log" 2>&1 &
  echo "$!" >"$pid_file"
  started=true
  attempts=0
  while ! probe; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 30 ]; then
      echo "remote broker did not become ready; see $log" >&2
      exit 1
    fi
    sleep 1
  done
fi

printf 'worktree=%s\nremotePort=%s\nrevision=%s\nupdated=%s\nstarted=%s\n' "$worktree" "$remote_port" "$current_revision" "$updated" "$started"
`;

const REMOTE_STOP_SCRIPT = String.raw`set -eu
worktree=$1
remote_port=$2

case "$worktree" in
  /*) ;;
  *) worktree="$HOME/$worktree" ;;
esac

pid_file="$worktree/.pw-dev-broker-$remote_port.pid"
if [ ! -s "$pid_file" ]; then
  echo "no pw-dev-managed remote broker pid file: $pid_file" >&2
  exit 3
fi

pid=$(cat "$pid_file")
case "$pid" in
  *[!0-9]*|'') echo "invalid remote broker pid file: $pid_file" >&2; exit 3 ;;
esac

if kill -0 "$pid" 2>/dev/null; then
  command=$(ps -p "$pid" -o args= 2>/dev/null || true)
  case "$command" in
    *packages/cdp-broker/bin/pw-cdp-broker.js*) ;;
    *) echo "pid $pid is not a pw-dev broker" >&2; exit 3 ;;
  esac
  kill -TERM "$pid"
  attempts=0
  while kill -0 "$pid" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 10 ]; then
      echo "remote broker pid $pid did not stop" >&2
      exit 1
    fi
    sleep 1
  done
fi

rm -f "$pid_file"
printf 'stopped=true\n'
`;

/**
 * Create the server-owned manager for remote brokers exposed through local SSH
 * forwards. Remote broker processes are deliberately not stopped on release:
 * they may serve another local forward or survive a pw-dev server restart.
 *
 * @param {{
 *   spawnSyncImpl?: typeof spawnSync,
 *   probe?: (brokerUrl: string) => Promise<void>,
 *   findLocalPort?: (start: number, end: number) => Promise<number>,
 *   now?: () => string,
 *   reconnectInitialDelayMs?: number,
 *   reconnectMaxDelayMs?: number,
 *   healthCheckIntervalMs?: number,
 *   localRevision?: string,
 *   controlPath?: string,
 * }=} options
 */
export function createRemoteBrokerManager(options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const probe = options.probe ?? probeBroker;
  const findLocalPort = options.findLocalPort ?? findAvailableLocalPort;
  const now = options.now ?? (() => new Date().toISOString());
  const reconnectInitialDelayMs = options.reconnectInitialDelayMs ?? RECONNECT_INITIAL_DELAY_MS;
  const reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? RECONNECT_MAX_DELAY_MS;
  const healthCheckIntervalMs = options.healthCheckIntervalMs ?? HEALTH_CHECK_INTERVAL_MS;
  const localRevision = options.localRevision ?? resolveLocalRevision();
  const controlPath = options.controlPath ?? prepareSshControlPath();
  const records = new Map();

  return {
    list() {
      return [...records.values()].map(publicRecord);
    },

    async provision(raw) {
      const request = validateProvisionRequest(raw, localRevision);
      if (records.has(request.id)) {
        throw httpError(409, `Remote broker "${request.id}" already has an active local forward`);
      }

      const localPort = request.localPort ?? await findLocalPort(LOCAL_PORT_START, LOCAL_PORT_END);
      const record = {
        ...request,
        localPort,
        brokerUrl: `http://127.0.0.1:${localPort}`,
        createdAt: now(),
        status: 'connecting',
        reconnectAttempts: 0,
        controlPath,
        released: false,
      };
      records.set(record.id, record);
      try {
        await connect(record);
      } catch (error) {
        record.released = true;
        clearTimeout(record.retryTimer);
        clearInterval(record.healthTimer);
        record.child?.kill?.('SIGTERM');
        records.delete(record.id);
        throw error;
      }
      return publicRecord(record);
    },

    async remove(id) {
      const record = records.get(id);
      if (!record) return false;
      records.delete(id);
      releaseRecord(record);
      return true;
    },

    async stop(id) {
      const record = records.get(id);
      if (!record) return false;
      records.delete(id);
      releaseRecord(record);
      runRemoteStop({ spawnSyncImpl, ...record });
      return true;
    },

    async close() {
      for (const id of [...records.keys()]) {
        await this.remove(id);
      }
    },
  };

  async function connect(record) {
    if (record.released) return;
    record.status = record.reconnectAttempts > 0 ? 'reconnecting' : 'connecting';
    ensureSshControlMaster({ spawnSyncImpl, target: record.target, controlPath: record.controlPath, identityFile: record.identityFile });
    const bootstrap = runRemoteBootstrap({ spawnSyncImpl, ...record });
    if (bootstrap.revision) record.remoteRevision = bootstrap.revision;
    if (bootstrap.updated !== undefined) record.remoteUpdated = bootstrap.updated === 'true';
    requestSshLocalForward({ spawnSyncImpl, ...record });
    try {
      await waitForForward({ probe, brokerUrl: record.brokerUrl });
    } catch (error) {
      cancelSshLocalForward({ spawnSyncImpl, ...record, ignoreFailure: true });
      throw error;
    }
    if (record.released) {
      cancelSshLocalForward({ spawnSyncImpl, ...record, ignoreFailure: true });
      return;
    }
    record.status = 'ready';
    record.reconnectAttempts = 0;
    delete record.lastError;
    startHealthCheck(record);
  }

  function scheduleReconnect(record) {
    if (record.released || record.retryTimer) return;
    const delayMs = Math.min(
      reconnectInitialDelayMs * (2 ** record.reconnectAttempts),
      reconnectMaxDelayMs
    );
    record.reconnectAttempts += 1;
    record.retryTimer = setTimeout(async () => {
      record.retryTimer = undefined;
      if (record.released) return;
      try {
        await connect(record);
      } catch (error) {
        record.status = 'reconnecting';
        record.lastError = error?.message || 'SSH reconnection failed';
        scheduleReconnect(record);
      }
    }, delayMs);
    record.retryTimer.unref?.();
  }

  function startHealthCheck(record) {
    clearInterval(record.healthTimer);
    let checking = false;
    record.healthTimer = setInterval(async () => {
      if (checking || record.released) return;
      checking = true;
      try {
        await probe(record.brokerUrl);
      } catch (error) {
        record.status = 'reconnecting';
        record.lastError = `Remote broker health check failed: ${error?.message || 'unreachable'}`;
        cancelSshLocalForward({ spawnSyncImpl, ...record, ignoreFailure: true });
        scheduleReconnect(record);
      } finally {
        checking = false;
      }
    }, healthCheckIntervalMs);
    record.healthTimer.unref?.();
  }

  function releaseRecord(record) {
    record.released = true;
    clearTimeout(record.retryTimer);
    clearInterval(record.healthTimer);
    cancelSshLocalForward({ spawnSyncImpl, ...record, ignoreFailure: true });
  }
}

/**
 * Build the non-interactive remote setup command. Arguments are passed to
 * remote `sh -s` positionally, never interpolated into shell source.
 */
export function buildSshRemoteBrokerBootstrapArgs({ target, repository, worktree, remotePort, revision, controlPath }) {
  return [
    ...(controlPath ? ['-o', `ControlPath=${controlPath}`] : []),
    '--', target, 'sh', '-s', '--', repository, worktree, String(remotePort), revision,
  ];
}

export function buildSshRemoteBrokerStopArgs({ target, worktree, remotePort, controlPath }) {
  return [
    ...(controlPath ? ['-o', `ControlPath=${controlPath}`] : []),
    '--', target, 'sh', '-s', '--', worktree, String(remotePort),
  ];
}

/** Build the local-only SSH forward from a remote broker to localhost. */
export function buildSshLocalForwardArgs({ target, localPort, remotePort, controlPath }) {
  return [
    '-O', 'forward',
    ...(controlPath ? ['-o', `ControlPath=${controlPath}`] : []),
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    '--',
    target,
  ];
}

export function buildSshLocalForwardCancelArgs({ target, localPort, remotePort, controlPath }) {
  return [
    '-O', 'cancel',
    ...(controlPath ? ['-o', `ControlPath=${controlPath}`] : []),
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    '--',
    target,
  ];
}

function runRemoteBootstrap({ spawnSyncImpl, target, repository, worktree, remotePort, revision, controlPath }) {
  const result = spawnSyncImpl(
    'ssh',
    buildSshRemoteBrokerBootstrapArgs({ target, repository, worktree, remotePort, revision, controlPath }),
    {
      input: REMOTE_BOOTSTRAP_SCRIPT,
      encoding: 'utf8',
      // A first-time Node download through NVM can take longer than ordinary
      // broker startup, especially on a fresh remote host.
      timeout: 300_000,
    }
  );
  if (result.error) throw httpError(502, `SSH setup failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw httpError(502, `Remote broker setup failed${detail ? `: ${detail}` : ''}`);
  }
  return parseKeyValueOutput(result.stdout);
}

function runRemoteStop({ spawnSyncImpl, target, worktree, remotePort, controlPath }) {
  const result = spawnSyncImpl(
    'ssh',
    buildSshRemoteBrokerStopArgs({ target, worktree, remotePort, controlPath }),
    {
      input: REMOTE_STOP_SCRIPT,
      encoding: 'utf8',
      timeout: 30_000,
    }
  );
  if (result.error) throw httpError(502, `SSH remote broker stop failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw httpError(result.status === 3 ? 409 : 502, `Remote broker stop failed${detail ? `: ${detail}` : ''}`);
  }
}

function requestSshLocalForward({ spawnSyncImpl, target, localPort, remotePort, controlPath }) {
  const result = spawnSyncImpl(
    'ssh',
    buildSshLocalForwardArgs({ target, localPort, remotePort, controlPath }),
    { encoding: 'utf8', timeout: 30_000 }
  );
  if (result.error) throw httpError(502, `SSH local forward failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw httpError(502, `SSH local forward failed${detail ? `: ${detail}` : ''}`);
  }
}

function cancelSshLocalForward({ spawnSyncImpl, target, localPort, remotePort, controlPath, ignoreFailure = false }) {
  const result = spawnSyncImpl(
    'ssh',
    buildSshLocalForwardCancelArgs({ target, localPort, remotePort, controlPath }),
    { encoding: 'utf8', timeout: 30_000 }
  );
  if (ignoreFailure || result.status === 0) return;
  const detail = String(result.stderr || result.stdout || '').trim();
  throw httpError(502, `SSH local forward release failed${detail ? `: ${detail}` : ''}`);
}

function validateProvisionRequest(raw, localRevision) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw httpError(400, 'Remote broker setup requires a JSON object');
  }
  const target = requiredString(raw.target, 'target');
  if (target.startsWith('-') || /[\r\n\0]/.test(target)) {
    throw httpError(400, 'target must be an SSH host or user@host');
  }
  const remotePort = optionalPort(raw.remotePort, 'remotePort') ?? DEFAULT_REMOTE_PORT;
  const localPort = optionalPort(raw.localPort, 'localPort');
  if (localPort && (localPort < LOCAL_PORT_START || localPort > LOCAL_PORT_END)) {
    throw httpError(400, `localPort must be between ${LOCAL_PORT_START} and ${LOCAL_PORT_END}`);
  }
  const id = raw.id === undefined
    ? `ssh-${target.replace(/[^A-Za-z0-9._-]+/g, '-')}-${remotePort}`
    : requiredIdentifier(raw.id, 'id');
  return {
    id,
    target,
    repository: raw.repository === undefined
      ? DEFAULT_REMOTE_REPOSITORY
      : requiredString(raw.repository, 'repository'),
    worktree: raw.worktree === undefined
      ? DEFAULT_REMOTE_WORKTREE
      : requiredString(raw.worktree, 'worktree'),
    revision: raw.revision === undefined
      ? requiredRevision(localRevision)
      : requiredRevision(raw.revision),
    ...(raw.identityFile ? { identityFile: requiredString(raw.identityFile, 'identityFile') } : {}),
    remotePort,
    localPort,
    connectionDirection: 'outward',
  };
}

function requiredRevision(value) {
  const revision = requiredString(value, 'revision');
  if (!/^[A-Za-z0-9._/-]+$/.test(revision) || revision.startsWith('-')) {
    throw httpError(400, 'revision must be a Git revision or ref name');
  }
  return revision;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw httpError(400, `${name} must be a non-empty string`);
  }
  return value.trim();
}

function requiredIdentifier(value, name) {
  const id = requiredString(value, name);
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
    throw httpError(400, `${name} must contain only letters, numbers, dot, underscore, and dash`);
  }
  return id;
}

function optionalPort(value, name) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw httpError(400, `${name} must be a TCP port between 1 and 65535`);
  }
  return value;
}

function resolveLocalRevision() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function prepareSshControlPath() {
  const controlDir = path.join(os.homedir(), '.pw-dev', 'ssh');
  mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  return path.join(controlDir, '%C');
}

function ensureSshControlMaster({ spawnSyncImpl, target, controlPath, identityFile }) {
  const result = spawnSyncImpl('ssh', [
    '-o', 'ControlMaster=auto',
    '-o', `ControlPersist=${SSH_CONTROL_PERSIST}`,
    '-o', `ControlPath=${controlPath}`,
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    ...(identityFile ? ['-i', identityFile, '-o', 'IdentitiesOnly=yes'] : []),
    '-N',
    '-f',
    '--',
    target,
  ], {
    stdio: 'inherit',
  });
  if (result.error) throw httpError(502, `SSH control master failed: ${result.error.message}`);
  if (result.status !== 0) throw httpError(502, `SSH control master exited with status ${result.status}`);
}

function parseKeyValueOutput(output) {
  const values = {};
  for (const line of String(output || '').split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0) values[line.slice(0, index)] = line.slice(index + 1);
  }
  return values;
}

async function waitForForward({ probe, brokerUrl }) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await probe(brokerUrl);
      return;
    } catch {
      await delay(100);
    }
  }
  throw httpError(502, `Remote broker is not reachable through ${brokerUrl}`);
}

function probeBroker(brokerUrl) {
  const url = new URL('/_broker/status', `${brokerUrl}/`);
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      response.on('end', () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) resolve();
        else reject(new Error(`Broker returned HTTP ${response.statusCode || 0}`));
      });
    });
    request.once('error', reject);
    request.setTimeout(1000, () => request.destroy(new Error('Broker probe timed out')));
  });
}

async function findAvailableLocalPort(start, end) {
  for (let port = start; port <= end; port += 1) {
    if (await canListen(port)) return port;
  }
  throw httpError(409, `No local broker port is available in ${start}-${end}`);
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

function publicRecord({ child, retryTimer, healthTimer, released, controlPath, ...record }) {
  return record;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
