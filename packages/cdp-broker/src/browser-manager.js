import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { buildChromeArgs, getFreePort, waitForChrome } from './chrome.js';
import { profileDirForName, validateProfileName } from './profiles.js';

export function createBrowserManager(options) {
  return new BrowserManager(options);
}

class BrowserManager {
  constructor({
    chromeExecutable,
    defaultProfile,
    defaultUserDataDir,
    defaultChromePort,
    headless = false,
    proxyServer,
    proxyBypassList,
    ignoreSslErrors = false,
    extraArgs = [],
    quiet = false,
    onUnexpectedExit,
    spawnImpl = spawn,
    getFreePortImpl = getFreePort,
    waitForChromeImpl = waitForChrome,
    log = console.log,
  }) {
    this.chromeExecutable = chromeExecutable;
    this.defaultProfile = defaultProfile;
    this.defaultUserDataDir = defaultUserDataDir;
    this.defaultChromePort = defaultChromePort;
    this.headless = headless;
    this.proxyServer = proxyServer;
    this.proxyBypassList = proxyBypassList;
    this.ignoreSslErrors = ignoreSslErrors;
    this.extraArgs = extraArgs;
    this.quiet = quiet;
    this.onUnexpectedExit = onUnexpectedExit;
    this.spawnImpl = spawnImpl;
    this.getFreePortImpl = getFreePortImpl;
    this.waitForChromeImpl = waitForChromeImpl;
    this.log = (...args) => {
      if (!quiet) log(...args);
    };
    this.instances = new Map();
  }

  activeInstance() {
    const instances = [...this.instances.values()];
    if (instances.length === 0) return undefined;
    if (instances.length === 1) return instances[0];
    const error = new Error(
      'Multiple Chrome instances are running; use an instance-scoped cdpUrl'
    );
    error.statusCode = 409;
    throw error;
  }

  listInstances() {
    return [...this.instances.values()].map((instance) => describeInstance(instance));
  }

  getInstance(instanceId) {
    return this.instances.get(instanceId);
  }

  async start(options = {}) {
    const launch = this.buildLaunchOptions(options);
    this.assertNoLaunchConflict(launch);
    if (launch.resetProfile) {
      fs.rmSync(launch.userDataDir, { recursive: true, force: true });
    }
    fs.mkdirSync(launch.userDataDir, { recursive: true });

    const chromePort = launch.chromePort ?? (await this.getFreePortImpl('127.0.0.1'));
    const chromeArgs = buildChromeArgs({
      remoteDebuggingPort: chromePort,
      userDataDir: launch.userDataDir,
      headless: launch.headless,
      proxyServer: launch.proxyServer,
      proxyBypassList: launch.proxyBypassList,
      ignoreSslErrors: launch.ignoreSslErrors,
      extraArgs: launch.extraArgs,
    });

    this.log(`Launching Chrome: ${this.chromeExecutable}`);
    this.log(`Chrome profile: ${launch.userDataDir}`);
    const child = this.spawnImpl(this.chromeExecutable, chromeArgs, {
      stdio: this.quiet ? 'ignore' : ['ignore', 'inherit', 'inherit'],
    });

    const instance = {
      id: makeInstanceId(),
      profile: launch.profile,
      userDataDir: launch.userDataDir,
      chromeHost: '127.0.0.1',
      chromePort,
      headless: launch.headless,
      proxyServer: launch.proxyServer,
      proxyForwardId: launch.proxyForwardId,
      networkId: launch.networkId,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      child,
    };
    this.instances.set(instance.id, instance);

    child.on('exit', (code, signal) => {
      if (this.instances.get(instance.id) === instance) {
        this.instances.delete(instance.id);
      }
      if (!instance.expectedStop && this.onUnexpectedExit) {
        this.onUnexpectedExit({ code, signal, instance: describeInstance(instance) });
      }
    });

    try {
      await this.waitForChromeImpl({ host: '127.0.0.1', port: chromePort });
    } catch (error) {
      await this.stop({ instanceId: instance.id });
      throw error;
    }

    return describeInstance(instance);
  }

  async stop({ instanceId } = {}) {
    if (this.instances.size === 0) return { stopped: false };
    if (!instanceId && this.instances.size > 1) {
      const error = new Error('instanceId is required when multiple Chrome instances are running');
      error.statusCode = 409;
      throw error;
    }

    const instance = instanceId
      ? this.instances.get(instanceId)
      : this.instances.values().next().value;
    if (!instance) {
      const error = new Error(`Unknown browser instance: ${instanceId}`);
      error.statusCode = 404;
      throw error;
    }

    instance.expectedStop = true;
    if (!instance.child.killed) {
      instance.child.kill('SIGTERM');
    }
    this.instances.delete(instance.id);
    return { stopped: true, instanceId: instance.id };
  }

  async stopAll() {
    const instances = [...this.instances.values()];
    for (const instance of instances) {
      instance.expectedStop = true;
      if (!instance.child.killed) {
        instance.child.kill('SIGTERM');
      }
      this.instances.delete(instance.id);
    }
    return instances.length;
  }

  clearProfileData({ profile } = {}) {
    if (!profile) {
      const error = new Error('profile is required');
      error.statusCode = 400;
      throw error;
    }
    validateProfileName(profile);
    const userDataDir = path.resolve(profileDirForName(profile));
    for (const instance of this.instances.values()) {
      if (path.resolve(instance.userDataDir) === userDataDir) {
        const error = new Error(`Profile is currently in use: ${profile}`);
        error.statusCode = 409;
        throw error;
      }
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
    return { cleared: true, profile, userDataDir };
  }

  buildLaunchOptions(options) {
    if (options.userDataDir) {
      const error = new Error('userDataDir cannot be set from remote start requests');
      error.statusCode = 400;
      throw error;
    }

    const profile = options.profile ?? this.defaultProfile;
    let userDataDir = this.defaultUserDataDir;
    if (!userDataDir) {
      if (!profile) {
        const error = new Error('profile is required');
        error.statusCode = 400;
        throw error;
      }
      validateProfileName(profile);
      userDataDir = profileDirForName(profile);
    } else if (options.profile && this.defaultProfile && options.profile !== this.defaultProfile) {
      const error = new Error(`profile must match configured profile: ${this.defaultProfile}`);
      error.statusCode = 400;
      throw error;
    }

    return {
      profile,
      userDataDir: path.resolve(userDataDir),
      chromePort: options.chromePort ?? this.defaultChromePort,
      headless: booleanOption(options.headless, this.headless),
      proxyServer: optionOrDefault(options, 'proxyServer', this.proxyServer),
      proxyForwardId: options.proxyForwardId,
      networkId: options.networkId,
      proxyBypassList: optionOrDefault(options, 'proxyBypassList', this.proxyBypassList),
      ignoreSslErrors: booleanOption(options.ignoreSslErrors, this.ignoreSslErrors),
      resetProfile: Boolean(options.resetProfile),
      extraArgs: mergeExtraArgs(this.extraArgs, options.chromeArg),
    };
  }

  assertNoLaunchConflict(launch) {
    for (const instance of this.instances.values()) {
      if (path.resolve(instance.userDataDir) === path.resolve(launch.userDataDir)) {
        const error = new Error(`Profile is already in use: ${launch.userDataDir}`);
        error.statusCode = 409;
        throw error;
      }
      if (launch.chromePort !== undefined && instance.chromePort === launch.chromePort) {
        const error = new Error(`Chrome port is already in use: ${launch.chromePort}`);
        error.statusCode = 409;
        throw error;
      }
    }
  }
}

function describeInstance(instance) {
  return {
    id: instance.id,
    profile: instance.profile,
    userDataDir: instance.userDataDir,
    chromeHost: instance.chromeHost,
    chromePort: instance.chromePort,
    headless: instance.headless,
    proxyServer: instance.proxyServer,
    proxyForwardId: instance.proxyForwardId,
    networkId: instance.networkId,
    pid: instance.pid,
    startedAt: instance.startedAt,
  };
}

function booleanOption(value, fallback) {
  return value === undefined ? fallback : Boolean(value);
}

function optionOrDefault(options, key, fallback) {
  return Object.hasOwn(options, key) ? options[key] : fallback;
}

function mergeExtraArgs(defaultArgs, requestArgs) {
  if (!requestArgs) return defaultArgs;
  if (Array.isArray(requestArgs)) return [...defaultArgs, ...requestArgs];
  return [...defaultArgs, requestArgs];
}

function makeInstanceId() {
  return `bkr_${crypto.randomBytes(16).toString('base64url')}`;
}
