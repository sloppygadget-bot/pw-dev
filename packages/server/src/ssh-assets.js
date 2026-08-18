import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function createSshAssetRegistry({ registryFile, keyDirectory }) {
  const state = load(registryFile);
  const keys = new Map(state.keys.map((key) => [key.id, key]));
  const hosts = new Map(state.hosts.map((host) => [host.id, host]));
  fs.mkdirSync(keyDirectory, { recursive: true, mode: 0o700 });

  const persist = () => {
    fs.mkdirSync(path.dirname(registryFile), { recursive: true, mode: 0o700 });
    const temp = `${registryFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, keys: [...keys.values()], hosts: [...hosts.values()] }, null, 2), { mode: 0o600 });
    fs.renameSync(temp, registryFile);
    fs.chmodSync(registryFile, 0o600);
  };
  const publicKey = (key) => ({ ...key });
  return {
    listKeys: () => [...keys.values()].sort(byId).map(publicKey),
    getKey: (id) => keys.get(id) && publicKey(keys.get(id)),
    importKey(raw) {
      const id = identifier(raw.id, 'id');
      const privateKey = required(raw.privateKey, 'privateKey');
      if (!privateKey.includes('PRIVATE KEY')) throw invalid('privateKey must be an OpenSSH or PEM private key');
      const now = new Date().toISOString();
      const file = path.join(keyDirectory, `${id}.key`);
      fs.writeFileSync(file, `${privateKey.trim()}\n`, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      const previous = keys.get(id);
      keys.set(id, { id, name: optional(raw.name) ?? id, fingerprint: fingerprint(privateKey), createdAt: previous?.createdAt ?? now, updatedAt: now });
      persist();
      return publicKey(keys.get(id));
    },
    deleteKey(id) {
      if ([...hosts.values()].some((host) => host.sshKeyId === id)) throw invalid(`SSH key "${id}" is referenced by a remote host`);
      if (!keys.delete(id)) return false;
      fs.rmSync(path.join(keyDirectory, `${id}.key`), { force: true });
      persist();
      return true;
    },
    listHosts: () => [...hosts.values()].sort(byId).map((host) => ({ ...host })),
    getHost: (id) => hosts.get(id) && { ...hosts.get(id) },
    upsertHost(raw) {
      const id = identifier(raw.id, 'id');
      const sshKeyId = identifier(raw.sshKeyId, 'sshKeyId');
      if (!keys.has(sshKeyId)) throw invalid(`Unknown SSH key: ${sshKeyId}`);
      const target = required(raw.target, 'target');
      const now = new Date().toISOString();
      const previous = hosts.get(id);
      const host = { id, name: optional(raw.name) ?? id, target, sshKeyId, createdAt: previous?.createdAt ?? now, updatedAt: now };
      hosts.set(id, host);
      persist();
      return { ...host };
    },
    deleteHost: (id) => {
      const deleted = hosts.delete(id);
      if (deleted) persist();
      return deleted;
    },
    identityFile(hostId) {
      const host = hosts.get(hostId);
      return host ? path.join(keyDirectory, `${host.sshKeyId}.key`) : undefined;
    },
  };
}

function load(file) {
  if (!fs.existsSync(file)) return { keys: [], hosts: [] };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { keys: Array.isArray(data.keys) ? data.keys : [], hosts: Array.isArray(data.hosts) ? data.hosts : [] };
}
function fingerprint(privateKey) { return `SHA256:${crypto.createHash('sha256').update(privateKey).digest('base64').replace(/=+$/, '')}`; }
function byId(a, b) { return a.id.localeCompare(b.id); }
function optional(value) { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function required(value, name) { if (!optional(value)) throw invalid(`${name} is required`); return value.trim(); }
function identifier(value, name) { const id = required(value, name); if (!/^[A-Za-z0-9._-]+$/.test(id)) throw invalid(`${name} must contain only letters, numbers, dot, underscore, or dash`); return id; }
function invalid(message) { const error = new Error(message); error.statusCode = 400; return error; }
