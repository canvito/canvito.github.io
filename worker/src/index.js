// Canvito API — Cloudflare Worker.
// Responsibilities: access-code redemption (one-time / time-bound / permanent), guest sessions,
// server-side decryption of PROTECTED content (key never leaves the worker), anonymous guestbook,
// rate limiting + Turnstile, and owner admin endpoints.
import {
  b64decode, importAesKey, openJSON, decryptBytes, sha256Hex, signToken, verifyToken,
  timingSafeEqual, generateCode, hashCode, normalizeCode, randomId,
} from '../../assets/js/crypto.js';

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const ASSET_RE = /^[a-z0-9]{4,40}$/;
const CODE_TYPES = new Set(['once', 'timed', 'permanent']);
const DAY = 86_400_000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

const allowedOrigins = (env) => String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

function corsHeaders(origin, env) {
  if (!origin || !allowedOrigins(env).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const clientIp = (req) => req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For')?.split(',')[0].trim() || 'unknown';

async function readJson(req, max = 16_384) {
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, 'Request too large');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

async function rateLimit(env, req, scope, limit, windowSec) {
  const win = Math.floor(Date.now() / 1000 / windowSec);
  const ipKey = (await sha256Hex(`${clientIp(req)}|${env.SESSION_SECRET || ''}`)).slice(0, 20);
  const key = `rl:${scope}:${ipKey}:${win}`;
  const n = parseInt((await env.KV.get(key)) || '0', 10);
  if (n >= limit) throw new HttpError(429, 'Too many attempts. Please wait a while and try again.');
  await env.KV.put(key, String(n + 1), { expirationTtl: Math.max(60, windowSec * 2) });
}

async function verifyTurnstile(env, req, token) {
  if (!env.TURNSTILE_SECRET) {
    if (env.ALLOW_NO_TURNSTILE === '1') return;
    throw new HttpError(503, 'Human verification is not configured');
  }
  if (!token || typeof token !== 'string' || token.length > 4096) throw new HttpError(400, 'Please complete the human check');
  const fd = new FormData();
  fd.append('secret', env.TURNSTILE_SECRET);
  fd.append('response', token);
  fd.append('remoteip', clientIp(req));
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: fd });
  const d = await r.json().catch(() => ({}));
  if (!d.success) throw new HttpError(403, 'Human check failed — please try again');
}

let keyCache;
async function protectedKey(env) {
  if (!env.PROTECTED_KEY) throw new HttpError(503, 'Protected content is not configured');
  if (keyCache?.raw !== env.PROTECTED_KEY) keyCache = { raw: env.PROTECTED_KEY, key: await importAesKey(b64decode(env.PROTECTED_KEY)) };
  return keyCache.key;
}

// Sealed content lives in a PRIVATE GitHub repo, read with a read-only fine-grained token (VAULT_TOKEN).
// CONTENT_BASE (plain HTTP origin) is only used by tests and tools/dev-worker.mjs.
async function fetchContent(env, path, as = 'json') {
  let r;
  if (env.CONTENT_BASE) {
    const base = env.CONTENT_BASE.endsWith('/') ? env.CONTENT_BASE : `${env.CONTENT_BASE}/`;
    r = await fetch(base + path);
  } else {
    if (!env.VAULT_TOKEN || !env.VAULT_REPO) throw new HttpError(503, 'Vault access is not configured');
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    const cacheKey = new Request(`https://vault.cache/${env.VAULT_REPO}/${env.VAULT_BRANCH || 'main'}/${path}`);
    r = await cache?.match(cacheKey);
    if (!r) {
      r = await fetch(`https://api.github.com/repos/${env.VAULT_REPO}/contents/${path}?ref=${encodeURIComponent(env.VAULT_BRANCH || 'main')}`, {
        headers: {
          Authorization: `Bearer ${env.VAULT_TOKEN}`,
          Accept: 'application/vnd.github.raw',
          'User-Agent': 'canvito-api',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (r.ok && cache) {
        // Only ciphertext is cached at the edge, briefly.
        const copy = new Response(r.clone().body, { headers: { 'cache-control': 'max-age=60' } });
        await cache.put(cacheKey, copy);
      }
    }
  }
  if (r.status === 404) return null;
  if (!r.ok) throw new HttpError(502, 'Vault unavailable');
  return as === 'json' ? r.json() : new Uint8Array(await r.arrayBuffer());
}

const stripKeys = (assets) => (assets || []).map(({ key, ...a }) => a);

async function getCodeRecord(env, hash) {
  const { metadata } = await env.KV.getWithMetadata(`code:${hash}`);
  return metadata || null;
}

function codeStatus(rec, now = Date.now()) {
  if (rec.revoked) return 'revoked';
  if (rec.expiresAt && now > Date.parse(rec.expiresAt)) return 'expired';
  if (rec.maxUses && rec.uses >= rec.maxUses) return 'used';
  return 'active';
}

// ---------- guest session ----------
async function requireGuest(req, env) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const p = await verifyToken(env.SESSION_SECRET, token);
  if (!p || !p.c || !p.exp || Date.now() > p.exp) throw new HttpError(401, 'Your access has expired');
  const rec = await getCodeRecord(env, p.c);
  if (!rec || rec.revoked || (rec.expiresAt && Date.now() > Date.parse(rec.expiresAt))) throw new HttpError(401, 'This access code is no longer valid');
  return p;
}

async function redeem(req, env) {
  const body = await readJson(req);
  await verifyTurnstile(env, req, body.turnstileToken);
  await rateLimit(env, req, 'redeem', 8, 900);
  const norm = normalizeCode(body.code);
  if (norm.length < 8 || norm.length > 64 || !/^[A-Z0-9]+$/.test(norm)) throw new HttpError(401, 'Invalid or expired code');
  const hash = await hashCode(norm);
  const rec = await getCodeRecord(env, hash);
  if (!rec || codeStatus(rec) !== 'active') throw new HttpError(401, 'Invalid or expired code');
  const now = Date.now();
  rec.uses = (rec.uses || 0) + 1;
  rec.lastUsedAt = new Date(now).toISOString();
  await env.KV.put(`code:${hash}`, '1', { metadata: rec });
  const hours = Number(env.SESSION_HOURS || 12);
  let exp = rec.type === 'permanent' ? now + 30 * DAY : now + hours * 3_600_000;
  if (rec.expiresAt) exp = Math.min(exp, Date.parse(rec.expiresAt));
  const token = await signToken(env.SESSION_SECRET, { c: hash, exp, l: rec.label });
  return json({ token, exp, label: rec.label, type: rec.type });
}

// ---------- protected content ----------
async function vaultIndex(env) {
  const envl = await fetchContent(env, 'data/vault/index-protected.json');
  if (!envl) return json({ v: 1, posts: [] });
  const idx = await openJSON(await protectedKey(env), envl, 'index:protected');
  for (const m of idx.posts) if (m.coverAsset) delete m.coverAsset.key;
  return json(idx);
}

async function loadProtectedPost(env, id) {
  if (!ID_RE.test(id)) throw new HttpError(404, 'Not found');
  const envl = await fetchContent(env, `data/vault/${id}.json`);
  if (!envl) throw new HttpError(404, 'Not found');
  try {
    return await openJSON(await protectedKey(env), envl, `post:${id}`);
  } catch {
    throw new HttpError(404, 'Not found'); // private entries fail authentication here by design
  }
}

async function vaultMedia(env, postId, assetId) {
  if (!ASSET_RE.test(assetId)) throw new HttpError(404, 'Not found');
  const post = await loadProtectedPost(env, postId);
  const asset = post.assets?.find((a) => a.id === assetId && a.key);
  if (!asset) throw new HttpError(404, 'Not found');
  const data = await fetchContent(env, `media/vault/${asset.id}.bin`, 'bytes');
  if (!data) throw new HttpError(404, 'Not found');
  const bytes = await decryptBytes(await importAesKey(asset.key), data, `asset:${asset.id}`);
  return new Response(bytes, {
    headers: { 'content-type': asset.mime || 'application/octet-stream', 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' },
  });
}

// ---------- guestbook ----------
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);

async function guestbookList(env) {
  const entries = (await env.KV.get('gb:public', 'json')) || [];
  return json({ entries }, 200, { 'cache-control': 'public, max-age=30' });
}

async function guestbookPost(req, env) {
  const body = await readJson(req);
  if (body.website) return json({ ok: true, pending: true }); // honeypot: pretend success
  await verifyTurnstile(env, req, body.turnstileToken);
  await rateLimit(env, req, 'gb', 3, 3600);
  const name = clean(body.name, 60);
  const message = clean(body.message, 2000);
  const from = clean(body.from, 60);
  if (!name || !message) throw new HttpError(400, 'Name and message are required');
  if ((message.match(/https?:\/\//g) || []).length > 2) throw new HttpError(400, 'Too many links in message');
  const entry = { id: randomId(10), name, from, message, private: !!body.private, createdAt: new Date().toISOString() };
  if (!entry.private && env.GUESTBOOK_AUTO_APPROVE === '1') {
    await publishEntry(env, entry);
    return json({ ok: true, pending: false });
  }
  await env.KV.put(`gbq:${entry.id}`, JSON.stringify(entry), { metadata: { createdAt: entry.createdAt, private: entry.private } });
  return json({ ok: true, pending: true });
}

async function publishEntry(env, entry) {
  const list = (await env.KV.get('gb:public', 'json')) || [];
  list.unshift({ id: entry.id, name: entry.name, from: entry.from, message: entry.message, createdAt: entry.createdAt });
  await env.KV.put('gb:public', JSON.stringify(list.slice(0, 1000)));
}

// ---------- admin ----------
async function requireAdmin(req, env) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_TOKEN || !timingSafeEqual(token, env.ADMIN_TOKEN)) {
    await rateLimit(env, req, 'adminfail', 10, 3600);
    throw new HttpError(401, 'Unauthorized');
  }
}

async function listAll(env, prefix) {
  const out = [];
  let cursor;
  do {
    const r = await env.KV.list({ prefix, cursor });
    out.push(...r.keys);
    cursor = r.list_complete ? undefined : r.cursor;
  } while (cursor);
  return out;
}

async function adminListCodes(env) {
  const keys = await listAll(env, 'code:');
  const codes = keys.filter((k) => k.metadata).map((k) => ({ ...k.metadata, status: codeStatus(k.metadata) }));
  codes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return json({ codes });
}

async function adminCreateCode(req, env) {
  const b = await readJson(req);
  const type = CODE_TYPES.has(b.type) ? b.type : 'once';
  let expiresAt = null;
  if (b.expiresAt) expiresAt = new Date(b.expiresAt);
  else if (b.hours) expiresAt = new Date(Date.now() + Number(b.hours) * 3_600_000);
  if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new HttpError(400, 'Invalid expiry');
  if (type === 'timed' && !expiresAt) throw new HttpError(400, 'Time-bound codes need an expiry');
  if (expiresAt && expiresAt.getTime() <= Date.now()) throw new HttpError(400, 'Expiry must be in the future');
  const code = b.code ? String(b.code).trim() : generateCode();
  const norm = normalizeCode(code);
  if (norm.length < 10 || norm.length > 64 || !/^[A-Z0-9]+$/.test(norm)) throw new HttpError(400, 'Custom codes need 10+ letters/digits');
  const hash = await hashCode(norm);
  if (await getCodeRecord(env, hash)) throw new HttpError(409, 'That code already exists');
  const maxUses = type === 'once' ? 1 : Math.max(0, parseInt(b.maxUses || 0, 10) || 0);
  const rec = {
    id: hash.slice(0, 12),
    label: clean(b.label, 80) || 'Guest',
    type,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    maxUses,
    uses: 0,
    revoked: false,
  };
  await env.KV.put(`code:${hash}`, '1', { metadata: rec });
  return json({ code, ...rec, status: 'active' }, 201);
}

async function adminRevokeCode(env, id, purge) {
  if (!/^[a-f0-9]{12}$/.test(id)) throw new HttpError(400, 'Bad id');
  const keys = await listAll(env, `code:${id}`);
  if (!keys.length) throw new HttpError(404, 'Not found');
  for (const k of keys) {
    if (purge) await env.KV.delete(k.name);
    else await env.KV.put(k.name, '1', { metadata: { ...k.metadata, revoked: true, revokedAt: new Date().toISOString() } });
  }
  return json({ ok: true });
}

async function adminGuestbook(env) {
  const keys = await listAll(env, 'gbq:');
  const queue = [];
  for (const k of keys) {
    const v = await env.KV.get(k.name, 'json');
    if (v) queue.push(v);
  }
  queue.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return json({ queue, published: (await env.KV.get('gb:public', 'json')) || [] });
}

async function adminApprove(env, id) {
  const entry = await env.KV.get(`gbq:${id}`, 'json');
  if (!entry) throw new HttpError(404, 'Not found');
  if (entry.private) throw new HttpError(400, 'Private notes cannot be published');
  await publishEntry(env, entry);
  await env.KV.delete(`gbq:${id}`);
  return json({ ok: true });
}

async function adminDeleteEntry(env, id) {
  await env.KV.delete(`gbq:${id}`);
  const list = (await env.KV.get('gb:public', 'json')) || [];
  const next = list.filter((e) => e.id !== id);
  if (next.length !== list.length) await env.KV.put('gb:public', JSON.stringify(next));
  return json({ ok: true });
}

// ---------- router ----------
async function route(req, env) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, '');
  const m = req.method;
  let r;
  if (p === '/api/health') return json({ ok: true, turnstile: !!env.TURNSTILE_SECRET, protected: !!env.PROTECTED_KEY, vault: !!(env.VAULT_TOKEN || env.CONTENT_BASE) });
  if (p === '/api/redeem' && m === 'POST') return redeem(req, env);
  if (p === '/api/session' && m === 'GET') {
    const s = await requireGuest(req, env);
    return json({ ok: true, exp: s.exp, label: s.l });
  }
  if (p === '/api/vault/index' && m === 'GET') {
    await requireGuest(req, env);
    return vaultIndex(env);
  }
  if ((r = p.match(/^\/api\/vault\/post\/([a-z0-9-]+)$/)) && m === 'GET') {
    await requireGuest(req, env);
    const post = await loadProtectedPost(env, r[1]);
    return json({ ...post, assets: stripKeys(post.assets) });
  }
  if ((r = p.match(/^\/api\/vault\/media\/([a-z0-9-]+)\/([a-z0-9]+)$/)) && m === 'GET') {
    await requireGuest(req, env);
    return vaultMedia(env, r[1], r[2]);
  }
  if (p === '/api/guestbook' && m === 'GET') return guestbookList(env);
  if (p === '/api/guestbook' && m === 'POST') return guestbookPost(req, env);
  if (p.startsWith('/api/admin/')) {
    await requireAdmin(req, env);
    if (p === '/api/admin/codes' && m === 'GET') return adminListCodes(env);
    if (p === '/api/admin/codes' && m === 'POST') return adminCreateCode(req, env);
    if ((r = p.match(/^\/api\/admin\/codes\/([a-f0-9]+)$/)) && m === 'DELETE') return adminRevokeCode(env, r[1], url.searchParams.get('purge') === '1');
    if (p === '/api/admin/guestbook' && m === 'GET') return adminGuestbook(env);
    if ((r = p.match(/^\/api\/admin\/guestbook\/([a-z0-9]+)\/approve$/)) && m === 'POST') return adminApprove(env, r[1]);
    if ((r = p.match(/^\/api\/admin\/guestbook\/([a-z0-9]+)$/)) && m === 'DELETE') return adminDeleteEntry(env, r[1]);
  }
  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin');
    const cors = corsHeaders(origin, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: cors['Access-Control-Allow-Origin'] ? 204 : 403, headers: cors });
    // Browsers from other sites are refused outright; non-browser clients (CLI) send no Origin.
    if (origin && !cors['Access-Control-Allow-Origin']) return json({ error: 'Origin not allowed' }, 403);
    let res;
    try {
      if (!env.SESSION_SECRET) throw new HttpError(503, 'Worker secrets are not configured');
      res = await route(req, env);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      res = json({ error: e instanceof HttpError ? e.message : 'Server error' }, e.status || 500);
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    out.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return out;
  },
};
