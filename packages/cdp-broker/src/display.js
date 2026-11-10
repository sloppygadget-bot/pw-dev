import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';

// One shared virtual display per manager, released after its last browser exits.
// Displays supplied by the environment or discovered locally are never stopped.
export function createDisplayManager({
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
  probeDisplayImpl = probeDisplay,
  listDisplaysImpl = listLocalDisplays,
  timeoutMs = 5_000,
  log = () => {},
} = {}) {
  let owned;
  let queue = Promise.resolve();
  const exclusive = (fn) => {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };

  return {
    acquire({ headless = false, display } = {}) {
      if (headless || platform !== 'linux') {
        return Promise.resolve({ display, release: async () => {} });
      }
      return exclusive(async () => {
        const configured = display || env.DISPLAY;
        if (configured) return { display: configured, release: async () => {} };

        if (owned && (owned.child.exitCode !== null || owned.child.signalCode)) owned = undefined;
        if (!owned) {
          for (const candidate of listDisplaysImpl()) {
            if (await probeDisplayImpl(candidate, env)) {
              log(`Reusing X display ${candidate}`);
              return { display: candidate, release: async () => {} };
            }
          }
          owned = await startXvfb({ env, spawnImpl, timeoutMs });
          log(`Started Xvfb display ${owned.display} (1920x1080x24)`);
        }

        const resource = owned;
        resource.users += 1;
        let releasing;
        return {
          display: resource.display,
          release: () => {
            releasing ??= exclusive(async () => {
              resource.users -= 1;
              if (resource.users === 0) {
                await stopXvfb(resource.child);
                if (owned === resource) owned = undefined;
              }
            });
            return releasing;
          },
        };
      });
    },
  };
}

function listLocalDisplays() {
  try {
    return fs.readdirSync('/tmp/.X11-unix')
      .filter((name) => /^X\d+$/.test(name))
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
      .map((name) => `:${name.slice(1)}`);
  } catch {
    return [];
  }
}

function probeDisplay(display, env) {
  return new Promise((resolve) => {
    execFile('xdpyinfo', ['-display', display], { env, timeout: 1_000, maxBuffer: 1024 * 1024 },
      (error) => resolve(!error));
  });
}

async function startXvfb({ env, spawnImpl, timeoutMs }) {
  // -displayfd chooses a free display atomically and signals when X is ready.
  const child = spawnImpl('Xvfb', [
    '-displayfd', '3', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp',
  ], { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-4_096); });
  try {
    const display = await new Promise((resolve, reject) => {
      let output = '';
      const finish = (error, value) => {
        clearTimeout(timer);
        child.off('error', onError);
        child.off('exit', onExit);
        child.stdio[3].off('data', onData);
        if (error) reject(error);
        else resolve(value);
      };
      const onError = (error) => finish(new Error(
        `Cannot start headed Chrome: Xvfb could not start (${error.message}). ` +
        'Install Xvfb or set DISPLAY to an accessible X server.'
      ));
      const onExit = (code, signal) => finish(new Error(
        `Xvfb exited before becoming ready (code=${code}, signal=${signal}): ${stderr.trim()}`
      ));
      const onData = (data) => {
        output += data;
        if (!output.includes('\n')) return;
        const number = output.trim();
        if (/^\d+$/.test(number)) finish(undefined, `:${number}`);
        else finish(new Error(`Xvfb returned an invalid display: ${number}`));
      };
      const timer = setTimeout(() => finish(new Error(
        `Xvfb did not become ready within ${timeoutMs}ms: ${stderr.trim()}`
      )), timeoutMs);
      child.once('error', onError);
      child.once('exit', onExit);
      child.stdio[3].on('data', onData);
    });
    return { child, display, users: 0 };
  } catch (error) {
    await stopXvfb(child);
    throw error;
  }
}

async function stopXvfb(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode) return;
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const exited = await new Promise((resolve) => {
      const onExit = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, 1_000);
      child.once('exit', onExit);
      child.kill(signal);
    });
    if (exited) return;
  }
  throw new Error('Xvfb did not exit after SIGTERM and SIGKILL');
}
