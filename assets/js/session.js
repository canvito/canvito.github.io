// Who is looking, and what can they see. Three modes share one UI:
//   public — anyone;  guest — redeemed an access code (protected content via the Worker);
//   owner  — unlocked the keyring with the passphrase (everything decrypted locally).
import { importAesKey, openKeyring, sealJSON, openJSON, normalizeCode } from './crypto.js';
import { Vault, TIERS } from './vault.js';
import { GitHubIO, StaticIO } from './github.js';

const OWNER_KEY = 'canvito.owner';
const GUEST_KEY = 'canvito.guest';
const PAT_KEY = 'canvito.pat';

export const S = {
  cfg: {},
  mode: 'public',
  keys: {},
  secrets: null,
  guest: null,
  pat: null,
  metas: [],
  byId: new Map(),
  listeners: new Set(),
};

const blobCache = new Map();

export const isOwner = () => S.mode === 'owner';
export const onChange = (fn) => S.listeners.add(fn);
const emit = () => S.listeners.forEach((fn) => fn());

async function fetchJSON(path) {
  const r = await fetch(path, { cache: 'no-cache' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

export class ApiError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body, auth } = {}) {
  if (!S.cfg.workerUrl) throw new ApiError(503, 'The access service is not configured yet.');
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (auth === 'guest' && S.guest) headers.Authorization = `Bearer ${S.guest.token}`;
  if (auth === 'admin' && S.secrets) headers.Authorization = `Bearer ${S.secrets.adminToken}`;
  let res;
  try {
    res = await fetch(S.cfg.workerUrl.replace(/\/$/, '') + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'Could not reach the access service.');
  }
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    if (res.status === 401 && auth === 'guest') expireGuest();
    throw new ApiError(res.status, d.error || `Request failed (${res.status})`);
  }
  return res.headers.get('content-type')?.includes('json') ? res.json() : res;
}

function expireGuest() {
  if (!S.guest) return;
  S.guest = null;
  S.mode = 'public';
  localStorage.removeItem(GUEST_KEY);
  setTimeout(() => loadIndex().then(emit), 0);
}

export function ownerIO() {
  return S.pat ? new GitHubIO({ ...S.cfg.repo, token: S.pat }) : new StaticIO('./');
}

export function ownerVault(io = ownerIO()) {
  return new Vault(io, S.keys);
}

let vaultCache;
const vault = () => (vaultCache ??= ownerVault());

async function becomeOwner(secrets, persist = true) {
  S.secrets = { protected: secrets.protected, private: secrets.private, adminToken: secrets.adminToken };
  S.keys = { protected: await importAesKey(secrets.protected), private: await importAesKey(secrets.private) };
  S.mode = 'owner';
  S.guest = null;
  localStorage.removeItem(GUEST_KEY);
  if (persist) sessionStorage.setItem(OWNER_KEY, JSON.stringify(S.secrets));
  const enc = localStorage.getItem(PAT_KEY);
  S.pat = null;
  if (enc) {
    try {
      S.pat = (await openJSON(S.keys.private, JSON.parse(enc), 'pat')).token;
    } catch {
      localStorage.removeItem(PAT_KEY);
    }
  }
  vaultCache = null;
}

export async function setPat(token) {
  if (!token) {
    localStorage.removeItem(PAT_KEY);
    S.pat = null;
  } else {
    const io = new GitHubIO({ ...S.cfg.repo, token });
    await io.check();
    localStorage.setItem(PAT_KEY, JSON.stringify(await sealJSON(S.keys.private, { token }, 'pat')));
    S.pat = token;
  }
  vaultCache = null;
}

export async function boot() {
  S.cfg = (await fetchJSON('config.json')) || {};
  const owner = sessionStorage.getItem(OWNER_KEY);
  if (owner) {
    try {
      await becomeOwner(JSON.parse(owner), false);
    } catch {
      sessionStorage.removeItem(OWNER_KEY);
    }
  }
  if (S.mode !== 'owner') {
    const g = JSON.parse(localStorage.getItem(GUEST_KEY) || 'null');
    if (g && g.exp > Date.now()) {
      S.guest = g;
      S.mode = 'guest';
    } else localStorage.removeItem(GUEST_KEY);
  }
  await loadIndex();
}

export async function loadIndex() {
  let metas = [];
  if (S.mode === 'owner') {
    vaultCache = null;
    try {
      metas = await vault().list();
    } catch (e) {
      console.error(e);
      metas = (await fetchJSON('data/public/index.json'))?.posts || [];
    }
  } else {
    metas = (await fetchJSON('data/public/index.json'))?.posts || [];
    if (S.mode === 'guest') {
      try {
        metas.push(...(await api('/api/vault/index', { auth: 'guest' })).posts.map((m) => ({ ...m, tier: 'protected' })));
      } catch (e) {
        console.warn(e.message);
      }
    }
  }
  metas.sort((a, b) => (a.date === b.date ? a.title.localeCompare(b.title) : b.date.localeCompare(a.date)));
  S.metas = metas;
  S.byId = new Map(metas.map((m) => [m.id, m]));
}

export async function getPost(id) {
  const meta = S.byId.get(id);
  if (!meta) return null;
  if (S.mode === 'owner') return vault().readPost(id, meta.tier);
  if (meta.tier === 'public') return fetchJSON(`data/public/posts/${encodeURIComponent(id)}.json`);
  if (S.mode === 'guest') return api(`/api/vault/post/${encodeURIComponent(id)}`, { auth: 'guest' });
  return null;
}

// Returns a URL usable in <img>/<video> for an asset of a given entry.
export async function assetUrl(postId, tier, asset) {
  if (!asset) return null;
  const ck = `${postId}/${asset.id}`;
  if (blobCache.has(ck)) return blobCache.get(ck);
  let url = null;
  const isVault = tier !== 'public' || asset.key;
  if (!isVault && !(S.mode === 'owner' && S.pat)) return `media/public/${asset.id}.${asset.ext}`;
  if (S.mode === 'owner') {
    const bytes = await vault().readAsset(asset);
    if (bytes) url = URL.createObjectURL(new Blob([bytes], { type: asset.mime }));
  } else if (S.mode === 'guest' && tier === 'protected') {
    const res = await api(`/api/vault/media/${postId}/${asset.id}`, { auth: 'guest' });
    url = URL.createObjectURL(await res.blob());
  }
  if (url) blobCache.set(ck, url);
  return url;
}

export async function unlock(secret, turnstileToken) {
  secret = String(secret || '').trim();
  if (!secret) throw new Error('Enter your access code');
  const keyring = await fetchJSON('data/keyring.json');
  if (keyring) {
    const s = await openKeyring(keyring, secret);
    if (s) {
      await becomeOwner(s);
      await loadIndex();
      emit();
      return { mode: 'owner' };
    }
  }
  const norm = normalizeCode(secret);
  if (!/^[A-Z0-9]{8,64}$/.test(norm)) throw new Error('That code was not recognized.');
  const r = await api('/api/redeem', { method: 'POST', body: { code: secret, turnstileToken } });
  S.guest = { token: r.token, exp: r.exp, label: r.label, type: r.type };
  S.mode = 'guest';
  localStorage.setItem(GUEST_KEY, JSON.stringify(S.guest));
  await loadIndex();
  emit();
  return { mode: 'guest', ...r };
}

export async function signOut() {
  sessionStorage.removeItem(OWNER_KEY);
  localStorage.removeItem(GUEST_KEY);
  for (const u of blobCache.values()) URL.revokeObjectURL(u);
  blobCache.clear();
  Object.assign(S, { mode: 'public', keys: {}, secrets: null, guest: null, pat: null });
  vaultCache = null;
  await loadIndex();
  emit();
}

export function refreshAfterWrite() {
  for (const u of blobCache.values()) URL.revokeObjectURL(u);
  blobCache.clear();
  return loadIndex().then(emit);
}

export const visibleTiers = () => (S.mode === 'owner' ? TIERS : S.mode === 'guest' ? ['public', 'protected'] : ['public']);
