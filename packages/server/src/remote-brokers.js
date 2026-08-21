import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const DEFAULT_REMOTE_REPOSITORY = 'https://github.com/sloppygadget-bot/pw-dev.git';
const DEFAULT_REMOTE_WORKTREE = '.pw-dev/pw-dev';
const DEFAULT_REMOTE_PORT = 18080;
const LOCAL_PORT_START = 18080;
const LOCAL_PORT_END = 18089;
const RECONNECT_INITIAL_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const HEALTH_CHECK_INTERVAL_MS = 10_000;
const SSH_COMMAND_TIMEOUT_MS = 30_000;
const SSH_BOOTSTRAP_TIMEOUT_MS = 300_000;
const FORWARD_STOP_GRACE_MS = 1_000;
const LOCAL_PORT_RELEASE_TIMEOUT_MS = 2_000;
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

port_available() {
  node -e '
    const net = require("net");
    const server = net.createServer();
    server.once("error", () => process.exit(1));
    server.listen(Number(process.argv[1]), "127.0.0.1", () => server.close(() => process.exit(0)));
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
  # A failed HTTP probe does not prove that the old process released its TCP
  # listener. Stop a verifiably managed process before replacing it, and never
  # overwrite its PID file with the PID of a replacement that cannot bind.
  if [ -s "$pid_file" ]; then
    stop_managed_broker
  elif ! port_available; then
    echo "remote port $remote_port is occupied by an unmanaged or unidentifiable process" >&2
    exit 3
  fi
  log="$worktree/.pw-dev-broker-$remote_port.log"
  pending_pid_file="$pid_file.pending.$$"
  nohup node "$worktree/packages/cdp-broker/bin/pw-cdp-broker.js" \
    --standby --host 127.0.0.1 --port "$remote_port" >"$log" 2>&1 &
  broker_pid=$!
  echo "$broker_pid" >"$pending_pid_file"
  started=true
  attempts=0
  while ! probe; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 30 ]; then
      kill -TERM "$broker_pid" 2>/dev/null || true
      rm -f "$pending_pid_file"
      echo "remote broker did not become ready; see $log" >&2
      exit 1
    fi
    sleep 1
  done
  mv "$pending_pid_file" "$pid_file"
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

// Windows OpenSSH normally launches cmd.exe, so the Windows implementation is
// sent as an encoded PowerShell command instead of relying on a POSIX shell.
// The JSON payload is embedded as base64, keeping user-provided paths and URLs
// out of the remote command line's quoting rules.
const REMOTE_WINDOWS_BOOTSTRAP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$worktree = [string]$pwDevPayload.worktree
$remotePort = [int]$pwDevPayload.remotePort
if (![IO.Path]::IsPathRooted($worktree)) { $worktree = Join-Path $HOME $worktree }
if ($remotePort -lt 1 -or $remotePort -gt 65535) { throw 'remote broker port must be between 1 and 65535' }
if (!(Get-Command node -ErrorAction SilentlyContinue)) { throw 'remote broker requires Node.js 18+' }
$nodeMajor = [int]((& node -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 18) { throw 'remote broker requires Node.js 18+' }
$broker = Join-Path $worktree 'packages\cdp-broker\bin\pw-cdp-broker.js'
if (!(Test-Path -LiteralPath $broker)) { throw "remote pw-dev broker source was not copied: $broker" }
$pidFile = Join-Path $worktree ".pw-dev-broker-$remotePort.pid"

function Test-PwDevBroker {
  & node -e 'const http=require("http");const r=http.get("http://127.0.0.1:"+process.argv[1]+"/_broker/status",x=>{x.resume();x.on("end",()=>process.exit(x.statusCode>=200&&x.statusCode<300?0:1))});r.on("error",()=>process.exit(1));r.setTimeout(1000,()=>r.destroy())' "$remotePort"
  return $LASTEXITCODE -eq 0
}

function Stop-ManagedBroker {
  if (!(Test-Path -LiteralPath $pidFile)) { throw "remote port $remotePort is unhealthy and has no pw-dev-managed pid file" }
  $managedPidText = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  $managedPid = [int]$managedPidText
  $managed = Get-CimInstance Win32_Process -Filter "ProcessId = $managedPid" -ErrorAction SilentlyContinue
  if ($managed) {
    if (([string]$managed.CommandLine).IndexOf($broker, [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw "pid $managedPid is not the pw-dev broker in $worktree" }
    Stop-Process -Id $managedPid -ErrorAction Stop
    try { Wait-Process -Id $managedPid -Timeout 10 -ErrorAction Stop } catch { Stop-Process -Id $managedPid -Force -ErrorAction SilentlyContinue }
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

$started = $false
if (!(Test-PwDevBroker)) {
  if (Test-Path -LiteralPath $pidFile) { Stop-ManagedBroker }
  $listener = $null
  try {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $remotePort)
    $listener.Start()
  } catch {
    throw "remote port $remotePort is occupied by an unmanaged or unidentifiable process"
  } finally {
    if ($listener) { $listener.Stop() }
  }
  $log = Join-Path $worktree ".pw-dev-broker-$remotePort.log"
  $errorLog = Join-Path $worktree ".pw-dev-broker-$remotePort.error.log"
  $brokerArgument = '"' + $broker.Replace('"', '\"') + '"'
  $process = Start-Process -FilePath (Get-Command node).Source -ArgumentList @($brokerArgument, '--standby', '--host', '127.0.0.1', '--port', "$remotePort") -RedirectStandardOutput $log -RedirectStandardError $errorLog -WindowStyle Hidden -PassThru
  $pendingPidFile = "$pidFile.pending.$PID"
  Set-Content -LiteralPath $pendingPidFile -Value $process.Id -NoNewline
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (Test-PwDevBroker) { $ready = $true; break }
    Start-Sleep -Milliseconds 100
  }
  if (!$ready) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $pendingPidFile -Force -ErrorAction SilentlyContinue
    throw "remote broker did not become ready; see $errorLog"
  }
  Move-Item -LiteralPath $pendingPidFile -Destination $pidFile -Force
  $started = $true
}
Write-Output "started=$($started.ToString().ToLowerInvariant())"
$managedPidText = (Get-Content -LiteralPath $pidFile -Raw).Trim()
$managedPid = [int]$managedPidText
$managed = Get-CimInstance Win32_Process -Filter "ProcessId = $managedPid" -ErrorAction SilentlyContinue
if (!$managed -or ([string]$managed.CommandLine).IndexOf($broker, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
  throw "pid $managedPid is not the pw-dev broker in $worktree"
}
# Keep the OpenSSH channel alive. Windows terminates remotely started child
# processes with their session, so this foreground owner is intentional.
Wait-Process -Id $managedPid
`;

const REMOTE_WINDOWS_STOP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$worktree = [string]$pwDevPayload.worktree
$remotePort = [int]$pwDevPayload.remotePort
if (![IO.Path]::IsPathRooted($worktree)) { $worktree = Join-Path $HOME $worktree }
$broker = Join-Path $worktree 'packages\cdp-broker\bin\pw-cdp-broker.js'
$pidFile = Join-Path $worktree ".pw-dev-broker-$remotePort.pid"
if (!(Test-Path -LiteralPath $pidFile)) { throw "no pw-dev-managed remote broker pid file: $pidFile" }
$managedPidText = (Get-Content -LiteralPath $pidFile -Raw).Trim()
$managedPid = [int]$managedPidText
$managed = Get-CimInstance Win32_Process -Filter "ProcessId = $managedPid" -ErrorAction SilentlyContinue
if ($managed) {
  if (([string]$managed.CommandLine).IndexOf($broker, [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw "pid $managedPid is not the pw-dev broker in $worktree" }
  Stop-Process -Id $managedPid -ErrorAction Stop
  try { Wait-Process -Id $managedPid -Timeout 10 -ErrorAction Stop } catch { Stop-Process -Id $managedPid -Force -ErrorAction SilentlyContinue }
}
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Output 'stopped=true'
`;

const REMOTE_WINDOWS_PREPARE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$worktree = [string]$pwDevPayload.worktree
if (![IO.Path]::IsPathRooted($worktree)) { $worktree = Join-Path $HOME $worktree }
New-Item -ItemType Directory -Force -Path (Join-Path $worktree 'packages') | Out-Null
`;

/**
 * Create the server-owned manager for remote brokers exposed through local SSH
 * forwards. Remote broker processes are deliberately not stopped on release:
 * they may serve another local forward or survive a pw-dev server restart.
 *
 * @param {{
 *   spawnImpl?: typeof spawn,
 *   runCommandImpl?: (command: string, args: string[], options?: Record<string, unknown>) => Promise<{ status: number | null, stdout?: string, stderr?: string, error?: Error }>,
 *   probe?: (brokerUrl: string) => Promise<void>,
 *   findLocalPort?: (start: number, end: number) => Promise<number>,
 *   isLocalPortAvailable?: (port: number) => Promise<boolean>,
 *   now?: () => string,
 *   reconnectInitialDelayMs?: number,
 *   reconnectMaxDelayMs?: number,
 *   healthCheckIntervalMs?: number,
 *   forwardStopGraceMs?: number,
 *   localPortReleaseTimeoutMs?: number,
 *   localRevision?: string,
 * }=} options
 */
export function createRemoteBrokerManager(options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn;
  const runCommandImpl = options.runCommandImpl ?? ((command, args, commandOptions) => runCommand({ spawnImpl, command, args, ...commandOptions }));
  const probe = options.probe ?? probeBroker;
  const findLocalPort = options.findLocalPort ?? findAvailableLocalPort;
  const isLocalPortAvailable = options.isLocalPortAvailable ?? canListen;
  const now = options.now ?? (() => new Date().toISOString());
  const reconnectInitialDelayMs = options.reconnectInitialDelayMs ?? RECONNECT_INITIAL_DELAY_MS;
  const reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? RECONNECT_MAX_DELAY_MS;
  const healthCheckIntervalMs = options.healthCheckIntervalMs ?? HEALTH_CHECK_INTERVAL_MS;
  const forwardStopGraceMs = options.forwardStopGraceMs ?? FORWARD_STOP_GRACE_MS;
  const localPortReleaseTimeoutMs = options.localPortReleaseTimeoutMs ?? LOCAL_PORT_RELEASE_TIMEOUT_MS;
  const localRevision = options.localRevision ?? resolveLocalRevision();
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
        controlPath: prepareSshControlPath(request.id, request.target),
        released: false,
        generation: 0,
      };
      records.set(record.id, record);
      try {
        await connectSerialized(record);
      } catch (error) {
        await releaseRecord(record);
        records.delete(record.id);
        throw error;
      }
      return publicRecord(record);
    },

    async remove(id) {
      const record = records.get(id);
      if (!record) return false;
      records.delete(id);
      await releaseRecord(record);
      return true;
    },

    async stop(id) {
      const record = records.get(id);
      if (!record) return false;
      records.delete(id);
      record.released = true;
      clearTimeout(record.retryTimer);
      clearTimeout(record.healthTimer);
      try {
        await runRemoteStop({ runCommandImpl, ...record });
      } finally {
        await releaseRecord(record);
      }
      return true;
    },

    async close() {
      for (const id of [...records.keys()]) {
        await this.remove(id);
      }
    },
  };

  function connectSerialized(record) {
    if (record.connectPromise) return record.connectPromise;
    const controller = new AbortController();
    record.connectController = controller;
    record.connectPromise = connect(record, controller.signal).finally(() => {
      delete record.connectPromise;
      if (record.connectController === controller) delete record.connectController;
    });
    return record.connectPromise;
  }

  async function connect(record, signal) {
    if (record.released) return;
    record.status = record.reconnectAttempts > 0 ? 'reconnecting' : 'connecting';
    await stopForward(record);
    if (!await isLocalPortAvailable(record.localPort)) {
      throw httpError(502, `Local broker port ${record.localPort} is still occupied after the previous SSH forward stopped`);
    }
    startForward(record);
    try {
      await Promise.race([
        waitForSshMaster({ runCommandImpl, signal, ...record }),
        forwardExitError(record),
      ]);
      if (record.released) {
        await stopForward(record);
        return;
      }
      if (record.platform === 'auto') {
        record.platform = await detectRemotePlatform({ runCommandImpl, signal, target: record.target, identityFile: record.identityFile, controlPath: record.controlPath });
      }
      if (record.platform === 'windows' && !record.windowsSourceCopied) {
        await copyWindowsBrokerSource({ runCommandImpl, signal, ...record });
        record.windowsSourceCopied = true;
      }
      let bootstrap = {};
      if (record.platform === 'windows') {
        await stopRemoteChild(record);
        startWindowsRemoteChild(record);
      } else {
        bootstrap = await runRemoteBootstrap({ runCommandImpl, signal, ...record });
      }
      if (bootstrap.revision) record.remoteRevision = bootstrap.revision;
      if (bootstrap.updated !== undefined) record.remoteUpdated = bootstrap.updated === 'true';
      await Promise.race([
        waitForForward({ probe, brokerUrl: record.brokerUrl }),
        forwardExitError(record),
        ...(record.remoteExit ? [remoteExitError(record)] : []),
      ]);
    } catch (error) {
      await stopRemoteChild(record);
      await stopForward(record);
      throw error;
    }
    if (record.released) {
      await stopForward(record);
      return;
    }
    record.status = 'ready';
    record.reconnectAttempts = 0;
    delete record.lastError;
    startHealthCheck(record);
  }

  function startForward(record) {
    removeControlSocket(record.controlPath);
    const generation = ++record.generation;
    const child = spawnImpl('ssh', buildSshLocalForwardArgs(record), {
      stdio: ['inherit', 'ignore', 'pipe'],
      windowsHide: true,
    });
    const exit = deferred();
    let stderr = '';
    child.stderr?.on?.('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_192);
    });
    child.once('error', (error) => exit.resolve({ code: null, signal: null, stderr: error.message }));
    child.once('exit', (code, signal) => exit.resolve({ code, signal, stderr: stderr.trim() }));
    record.forwardChild = child;
    record.forwardExit = exit;
    exit.promise.then(({ code, signal, stderr: detail }) => {
      if (record.released || record.generation !== generation || record.forwardChild !== child) return;
      record.forwardChild = undefined;
      beginReconnect(record, `SSH local forward exited: code=${code} signal=${signal}${detail ? `: ${detail}` : ''}`);
    });
  }

  function forwardExitError(record) {
    return record.forwardExit.promise.then(({ code, signal, stderr }) => {
      throw httpError(502, `SSH local forward exited before becoming ready: code=${code} signal=${signal}${stderr ? `: ${stderr}` : ''}`);
    });
  }

  function startWindowsRemoteChild(record) {
    const child = spawnImpl('ssh', buildSshRemoteBrokerBootstrapArgs({ ...record, platform: 'windows' }), {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    const exit = deferred();
    let stderr = '';
    child.stderr?.on?.('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_192); });
    child.once('error', (error) => exit.resolve({ code: null, signal: null, stderr: error.message }));
    child.once('exit', (code, signal) => exit.resolve({ code, signal, stderr: stderr.trim() }));
    record.remoteChild = child;
    record.remoteExit = exit;
  }

  function remoteExitError(record) {
    return record.remoteExit.promise.then(({ code, signal, stderr }) => {
      throw httpError(502, `Windows remote broker SSH process exited before readiness: code=${code} signal=${signal}${stderr ? `: ${stderr}` : ''}`);
    });
  }

  async function stopRemoteChild(record) {
    const child = record.remoteChild;
    const exit = record.remoteExit;
    record.remoteChild = undefined;
    record.remoteExit = undefined;
    if (child) await stopChild(child, forwardStopGraceMs, exit?.promise);
  }

  async function stopForward(record) {
    const child = record.forwardChild;
    const exit = record.forwardExit;
    record.generation += 1;
    record.forwardChild = undefined;
    record.forwardExit = undefined;
    if (child) await stopChild(child, forwardStopGraceMs, exit?.promise);
    removeControlSocket(record.controlPath);
    if (!await waitForLocalPortAvailable(record.localPort, isLocalPortAvailable, localPortReleaseTimeoutMs)) {
      throw httpError(502, `SSH local forward did not release local port ${record.localPort}`);
    }
  }

  function beginReconnect(record, message) {
    if (record.released || record.recoveryPromise) return;
    record.status = 'reconnecting';
    record.lastError = message;
    clearTimeout(record.healthTimer);
    record.healthTimer = undefined;
    record.recoveryPromise = stopForward(record)
      .catch((error) => {
        record.lastError = error?.message || message;
      })
      .finally(() => {
        delete record.recoveryPromise;
        scheduleReconnect(record);
      });
  }

  function scheduleReconnect(record) {
    if (record.released || record.retryTimer || record.connectPromise) return;
    const delayMs = Math.min(
      reconnectInitialDelayMs * (2 ** record.reconnectAttempts),
      reconnectMaxDelayMs
    );
    record.reconnectAttempts += 1;
    record.retryTimer = setTimeout(async () => {
      record.retryTimer = undefined;
      if (record.released) return;
      try {
        await connectSerialized(record);
      } catch (error) {
        record.status = 'reconnecting';
        record.lastError = error?.message || 'SSH reconnection failed';
        scheduleReconnect(record);
      }
    }, delayMs);
    record.retryTimer.unref?.();
  }

  function startHealthCheck(record) {
    clearTimeout(record.healthTimer);
    record.healthTimer = setTimeout(async () => {
      record.healthTimer = undefined;
      if (record.released || record.status !== 'ready') return;
      try {
        await probe(record.brokerUrl);
      } catch (error) {
        beginReconnect(record, `Remote broker health check failed: ${error?.message || 'unreachable'}`);
        return;
      }
      startHealthCheck(record);
    }, healthCheckIntervalMs);
    record.healthTimer.unref?.();
  }

  async function releaseRecord(record) {
    record.released = true;
    clearTimeout(record.retryTimer);
    clearTimeout(record.healthTimer);
    record.connectController?.abort();
    await record.recoveryPromise?.catch?.(() => undefined);
    if (record.connectPromise) await settlesWithin(record.connectPromise, forwardStopGraceMs + 1_000);
    await stopRemoteChild(record);
    await stopForward(record);
  }
}

/**
 * Build the non-interactive remote setup command. Arguments are passed to
 * remote `sh -s` positionally, never interpolated into shell source.
 */
export function buildSshRemoteBrokerBootstrapArgs({ target, repository, worktree, remotePort, revision, identityFile, controlPath, platform = 'linux' }) {
  if (platform === 'windows') {
    return buildSshWindowsCommandArgs({ target, identityFile, controlPath, script: REMOTE_WINDOWS_BOOTSTRAP_SCRIPT, payload: { worktree, remotePort } });
  }
  return [
    ...sshCommandConnectionArgs({ identityFile, controlPath }),
    '--', target, 'sh', '-s', '--', repository, worktree, String(remotePort), revision,
  ];
}

export function buildSshRemoteBrokerStopArgs({ target, worktree, remotePort, identityFile, controlPath, platform = 'linux' }) {
  if (platform === 'windows') {
    return buildSshWindowsCommandArgs({ target, identityFile, controlPath, script: REMOTE_WINDOWS_STOP_SCRIPT, payload: { worktree, remotePort } });
  }
  return [
    ...sshCommandConnectionArgs({ identityFile, controlPath }),
    '--', target, 'sh', '-s', '--', worktree, String(remotePort),
  ];
}

/** Build the local-only SSH forward from a remote broker to localhost. */
export function buildSshLocalForwardArgs({ target, localPort, remotePort, identityFile, controlPath }) {
  return [
    '-N',
    ...(controlPath ? ['-o', 'ControlMaster=yes', '-o', 'ControlPersist=no', '-o', `ControlPath=${controlPath}`] : []),
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    ...sshIdentityArgs(identityFile),
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

async function runRemoteBootstrap({ runCommandImpl, signal, target, repository, worktree, remotePort, revision, identityFile, controlPath, platform }) {
  const result = await runCommandImpl(
    'ssh',
    buildSshRemoteBrokerBootstrapArgs({ target, repository, worktree, remotePort, revision, identityFile, controlPath, platform }),
    {
      input: REMOTE_BOOTSTRAP_SCRIPT,
      signal,
      // A first-time Node download through NVM can take longer than ordinary
      // broker startup, especially on a fresh remote host.
      timeoutMs: SSH_BOOTSTRAP_TIMEOUT_MS,
    }
  );
  if (result.error) throw httpError(502, `SSH setup failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw httpError(502, `Remote broker setup failed${detail ? `: ${detail}` : ''}`);
  }
  return parseKeyValueOutput(result.stdout);
}

async function copyWindowsBrokerSource({ runCommandImpl, signal, target, worktree, identityFile, controlPath }) {
  const prepared = await runCommandImpl('ssh', buildSshWindowsCommandArgs({
    target,
    identityFile,
    controlPath,
    script: REMOTE_WINDOWS_PREPARE_SCRIPT,
    payload: { worktree },
  }), { timeoutMs: SSH_COMMAND_TIMEOUT_MS, signal });
  if (prepared.error || prepared.status !== 0) {
    const detail = String(prepared.error?.message || prepared.stderr || prepared.stdout || '').trim();
    throw httpError(502, `Windows source-copy preparation failed${detail ? `: ${detail}` : ''}`);
  }
  const result = await runCommandImpl('scp', [
    '-r', '-p',
    ...sshCommandConnectionArgs({ identityFile, controlPath }),
    path.join(REPOSITORY_ROOT, 'packages', 'cdp-broker'),
    `${target}:${worktree.replaceAll('\\', '/')}/packages`,
  ], { timeoutMs: SSH_BOOTSTRAP_TIMEOUT_MS, signal });
  if (result.error || result.status !== 0) {
    const detail = String(result.error?.message || result.stderr || result.stdout || '').trim();
    throw httpError(502, `Windows source copy failed${detail ? `: ${detail}` : ''}`);
  }
}

async function runRemoteStop({ runCommandImpl, target, worktree, remotePort, identityFile, controlPath, platform }) {
  const result = await runCommandImpl(
    'ssh',
    buildSshRemoteBrokerStopArgs({ target, worktree, remotePort, identityFile, controlPath, platform }),
    {
      ...(platform === 'windows' ? {} : { input: REMOTE_STOP_SCRIPT }),
      timeoutMs: SSH_COMMAND_TIMEOUT_MS,
    }
  );
  if (result.error) throw httpError(502, `SSH remote broker stop failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw httpError(result.status === 3 ? 409 : 502, `Remote broker stop failed${detail ? `: ${detail}` : ''}`);
  }
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
    platform: optionalPlatform(raw.platform),
    remotePort,
    localPort,
    connectionDirection: 'outward',
  };
}

function optionalPlatform(value) {
  if (value === undefined) return 'auto';
  if (value === 'auto' || value === 'linux' || value === 'windows') return value;
  throw httpError(400, 'platform must be "auto", "linux", or "windows"');
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

function prepareSshControlPath(id, target) {
  const controlDir = path.join(os.homedir(), '.pw-dev', 'ssh');
  mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  const digest = createHash('sha256').update(`${id}\0${target}`).digest('hex').slice(0, 16);
  return path.join(controlDir, `remote-${process.pid}-${digest}.sock`);
}

function removeControlSocket(controlPath) {
  if (!controlPath) return;
  try {
    unlinkSync(controlPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function detectRemotePlatform({ runCommandImpl, signal, target, identityFile, controlPath }) {
  const options = { timeoutMs: 15_000, signal };
  const linux = await runCommandImpl('ssh', [
    ...sshCommandConnectionArgs({ identityFile, controlPath }), '--', target, 'uname', '-s',
  ], options);
  if (linux.status === 0 && /linux|darwin|freebsd|openbsd|netbsd/i.test(String(linux.stdout))) return 'linux';
  const windows = await runCommandImpl('ssh', [
    // `ver` is a cmd.exe built-in. Sending it directly avoids OpenSSH's
    // Windows command-line re-quoting of `cmd /c ver`.
    ...sshCommandConnectionArgs({ identityFile, controlPath }), '--', target, 'ver',
  ], options);
  if (windows.status === 0 && /windows/i.test(String(windows.stdout))) return 'windows';
  const detail = String(windows.stderr || windows.stdout || linux.stderr || linux.stdout || '').trim();
  throw httpError(502, `Unable to detect remote platform${detail ? `: ${detail}` : ''}; set platform to "linux" or "windows"`);
}

function buildWindowsPowerShellCommand(script, payload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const source = `$pwDevPayload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPayload}')) | ConvertFrom-Json\n${script}`;
  // Windows' legacy command line is limited to 8,191 characters. Compress the
  // UTF-16 script before wrapping it in -EncodedCommand so OpenSSH can invoke
  // even the full bootstrap without exceeding that limit.
  const compressed = gzipSync(Buffer.from(source, 'utf16le')).toString('base64');
  const launcher = `$bytes=[Convert]::FromBase64String('${compressed}');$input=New-Object IO.MemoryStream(,$bytes);$gzip=New-Object IO.Compression.GzipStream($input,[IO.Compression.CompressionMode]::Decompress);$reader=New-Object IO.StreamReader($gzip,[Text.Encoding]::Unicode);Invoke-Expression $reader.ReadToEnd()`;
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ${launcher}`;
}

function buildSshWindowsCommandArgs({ target, identityFile, controlPath, script, payload }) {
  return [
    ...sshCommandConnectionArgs({ identityFile, controlPath }),
    '--', target,
    buildWindowsPowerShellCommand(script, payload),
  ];
}

function sshIdentityArgs(identityFile) {
  return identityFile ? ['-i', identityFile, '-o', 'IdentitiesOnly=yes'] : [];
}

function sshCommandConnectionArgs({ identityFile, controlPath }) {
  return [
    ...(controlPath ? ['-o', 'ControlMaster=auto', '-o', `ControlPath=${controlPath}`] : []),
    ...sshIdentityArgs(identityFile),
  ];
}

function parseKeyValueOutput(output) {
  const values = {};
  for (const line of String(output || '').split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0) values[line.slice(0, index)] = line.slice(index + 1);
  }
  return values;
}

async function waitForSshMaster({ runCommandImpl, signal, target, controlPath, identityFile }) {
  let lastResult;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (signal?.aborted) throw abortError('SSH connection setup aborted');
    lastResult = await runCommandImpl('ssh', [
      '-O', 'check',
      ...sshCommandConnectionArgs({ identityFile, controlPath }),
      '--', target,
    ], { timeoutMs: 1_000, signal });
    if (lastResult.status === 0) return;
    await delay(250);
  }
  const detail = String(lastResult?.error?.message || lastResult?.stderr || lastResult?.stdout || '').trim();
  throw httpError(502, `SSH forwarding connection did not become ready${detail ? `: ${detail}` : ''}`);
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

async function waitForLocalPortAvailable(port, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await check(port)) return true;
    await delay(25);
  } while (Date.now() < deadline);
  return false;
}

function isChildRunning(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null && !child.killed);
}

async function stopChild(child, graceMs, exitPromise) {
  if (!isChildRunning(child)) return;
  const exited = exitPromise ?? new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  if (await settlesWithin(exited, graceMs)) return;
  child.kill('SIGKILL');
  await settlesWithin(exited, Math.max(100, graceMs));
}

async function settlesWithin(promise, timeoutMs) {
  return Promise.race([
    Promise.resolve(promise).then(() => true, () => true),
    delay(timeoutMs).then(() => false),
  ]);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function runCommand({ spawnImpl, command, args, input, timeoutMs = SSH_COMMAND_TIMEOUT_MS, signal }) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let deadline;
    let forceKill;
    let terminalError;
    let abortCommand;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(forceKill);
      if (abortCommand) signal?.removeEventListener('abort', abortCommand);
      resolve({ stdout, stderr, ...result });
    };
    let child;
    try {
      child = spawnImpl(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      finish({ status: null, error });
      return;
    }
    child.stdout?.on?.('data', (chunk) => { stdout += chunk; });
    child.stderr?.on?.('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish({ status: null, error }));
    child.once('close', (status, signal) => finish({ status, signal, ...(terminalError ? { error: terminalError } : {}) }));
    const terminate = (error) => {
      if (terminalError) return;
      terminalError = error;
      child.kill?.('SIGTERM');
      forceKill = setTimeout(() => {
        child.kill?.('SIGKILL');
        finish({ status: null, error: terminalError });
      }, 1_000);
      forceKill.unref?.();
    };
    deadline = setTimeout(() => {
      const error = new Error(`${command} timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      terminate(error);
    }, timeoutMs);
    deadline.unref?.();
    abortCommand = () => terminate(abortError(`${command} aborted`));
    if (signal?.aborted) abortCommand();
    else signal?.addEventListener('abort', abortCommand, { once: true });
    if (input === undefined) child.stdin?.end?.();
    else child.stdin?.end?.(input);
  });
}

function abortError(message) {
  const error = new Error(message);
  error.code = 'ABORT_ERR';
  return error;
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

function publicRecord({ forwardChild, forwardExit, remoteChild, remoteExit, retryTimer, healthTimer, recoveryPromise, connectPromise, connectController, released, generation, windowsSourceCopied, controlPath, ...record }) {
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
