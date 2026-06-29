import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const LINUX_EXECUTABLES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'brave-browser',
];

const MAC_EXECUTABLES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

export function buildChromeArgs({
  remoteDebuggingPort,
  userDataDir,
  headless = false,
  proxyServer,
  proxyBypassList,
  ignoreSslErrors = false,
  extraArgs = [],
}) {
  const args = [
    `--remote-debugging-port=${remoteDebuggingPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
  ];
  if (headless) args.push('--headless=new');
  if (proxyServer) args.push(`--proxy-server=${proxyServer}`);
  if (proxyBypassList) args.push(`--proxy-bypass-list=${proxyBypassList}`);
  if (ignoreSslErrors) args.push('--ignore-certificate-errors');
  args.push(...extraArgs);
  args.push('about:blank');
  return args;
}

export function findChromeExecutable(explicitPath) {
  if (explicitPath && fs.existsSync(explicitPath)) return explicitPath;

  const names = process.platform === 'darwin' ? MAC_EXECUTABLES : LINUX_EXECUTABLES;
  for (const candidate of names) {
    if (path.isAbsolute(candidate)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    const resolved = spawnSync('which', [candidate], { encoding: 'utf8' });
    if (resolved.status === 0 && resolved.stdout.trim()) {
      return resolved.stdout.trim().split(/\r?\n/)[0];
    }
  }

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    const programFiles = process.env.PROGRAMFILES;
    const programFilesX86 = process.env['PROGRAMFILES(X86)'];
    const windowsCandidates = [
      local && path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
      programFiles && path.join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'),
      programFilesX86 && path.join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
    ].filter(Boolean);
    for (const candidate of windowsCandidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return undefined;
}

export async function getFreePort(host = '127.0.0.1') {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => {
        if (port) resolve(port);
        else reject(new Error('Could not allocate a free TCP port'));
      });
    });
  });
}

export async function waitForChrome({
  host,
  port,
  timeoutMs = 15000,
  intervalMs = 250,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      await httpGetJson({ host, port, path: '/json/version' });
      return;
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }

  throw new Error(
    `Chrome did not expose CDP on ${host}:${port} within ${timeoutMs}ms` +
      (lastError ? `: ${lastError.message}` : '')
  );
}

export function brokerHome() {
  return path.join(os.homedir(), '.pw-cdp-broker');
}

function httpGetJson({ host, port, path: requestPath }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host,
        port,
        path: requestPath,
        method: 'GET',
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          if (!response.statusCode || response.statusCode >= 400) {
            reject(new Error(`HTTP ${response.statusCode || 0}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.once('error', reject);
    request.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
