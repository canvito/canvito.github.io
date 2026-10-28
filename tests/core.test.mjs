import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createKeyring, openKeyring, importAesKey, newRawKey, sealJSON, openJSON, generateCode, normalizeCode, signToken, verifyToken,
} from '../assets/js/crypto.js';
import { renderMarkdown, plainText, mediaRefs } from '../assets/js/markdown.js';
import { Vault, paths } from '../assets/js/vault.js';
import worker from '../worker/src/index.js';

class MemIO {
  constructor() {
    this.files = new Map();
  }
  async readBytes(p) {
    const v = this.files.get(p);
    return v === undefined ? null : typeof v === 'string' ? new TextEncoder().encode(v) : v;
  }
  async readText(p) {
    const b = await this.readBytes(p);
    return b && new TextDecoder().decode(b);
  }
  async write(p, d) {
    this.files.set(p, d);
  }
  async remove(p) {
    this.files.delete(p);
  }
}

async function makeVault() {
  const raw = { protected: newRawKey(), private: newRawKey() };
  const io = new MemIO();
  const vault = new Vault(io, { protected: await importAesKey(raw.protected), private: await importAesKey(raw.private) });
  return { io, vault, raw };
}

// ---------- crypto ----------
test('keyring opens only with the right passphrase', async () => {
  const kr = await createKeyring('correct horse battery staple', { a: 1 }, 1000);
  assert.deepEqual(await openKeyring(kr, 'correct horse battery staple'), { a: 1 });
  assert.equal(await openKeyring(kr, 'wrong'), null);
});

test('sealed JSON is bound to its AAD slot', async () => {
  const k = await importAesKey(newRawKey());
  const env = await sealJSON(k, { x: 1 }, 'post:a');
  assert.deepEqual(await openJSON(k, env, 'post:a'), { x: 1 });
  await assert.rejects(openJSON(k, env, 'post:b'));
});

test('codes normalize ambiguous characters; tokens reject tampering', async () => {
  const c = generateCode();
  assert.match(c, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
  assert.equal(normalizeCode('abco-il11'), 'ABC01111');
  const t = await signToken('s', { c: 'x', exp: 1 });
  assert.deepEqual(await verifyToken('s', t), { c: 'x', exp: 1 });
  assert.equal(await verifyToken('other', t), null);
  assert.equal(await verifyToken('s', `${t.split('.')[0]}x.${t.split('.')[1]}`), null);
});

// ---------- markdown ----------
test('markdown never emits script-capable markup', () => {
  const evil = [
    '<script>alert(1)</script>',
    '[x](javascript:alert(1))',
    '[x](java\tscript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '![a](data:text/html,<script>alert(1)</script>)',
    '[x](https://ok.test" onmouseover="alert(1))',
    '@[cap](javascript:alert(1))',
    '<img src=x onerror=alert(1)>',
  ].join('\n\n');
  const html = renderMarkdown(evil);
  const tags = html.match(/<[a-z][^>]*>/gi) || [];
  assert.ok(!tags.some((t) => /^<(script|iframe|object|embed|style)/i.test(t)), 'no dangerous tags');
  assert.ok(!tags.some((t) => /\son\w+=|(href|src)="\s*(javascript|data|vbscript):/i.test(t)), `no handlers/js urls in ${tags.join(' ')}`);
});

test('markdown renders rich blocks and media references', () => {
  const html = renderMarkdown(
    '# Title\n\n**b** *i* ==m== `c`\n\n- [x] done\n- item\n\n> [!LESSON] Takeaway\n> keep going\n\n@[Talk](https://youtu.be/dQw4w9WgXcQ)\n\n![one](media:abcd1234) ![two](media:efgh5678)\n\n| a | b |\n|---|---|\n| 1 | 2 |',
    { asset: (id) => ({ mime: 'image/jpeg', name: id }) },
  );
  assert.match(html, /<h2 id="h-title">Title<\/h2>/);
  assert.match(html, /<strong>b<\/strong> <em>i<\/em> <mark>m<\/mark> <code>c<\/code>/);
  assert.match(html, /<input type="checkbox" disabled checked>/);
  assert.match(html, /callout-lesson/);
  assert.match(html, /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
  assert.match(html, /class="gallery g2".*data-asset="abcd1234".*data-asset="efgh5678"/s);
  assert.match(html, /<table>/);
  assert.equal(plainText('## Hi **there** [link](http://x)'), 'Hi there link');
  assert.deepEqual(mediaRefs('![a](media:abcd1234) and media:abcd1234'), ['abcd1234']);
});

// ---------- vault ----------
test('vault moves attachments between public and sealed storage with the tier', async () => {
  const { io, vault } = await makeVault();
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const a = await vault.addAsset(bytes, { name: 'pic.jpg' }, 'public');
  const post = await vault.savePost({ title: 'Trip', date: '2010-07', tier: 'public', body: `![x](media:${a.id})`, assets: [a] });
  assert.ok(io.files.has(paths.publicAsset(a)));

  const sealed = await vault.savePost({ ...post, tier: 'private' });
  assert.ok(!io.files.has(paths.publicAsset(a)), 'public copy removed');
  assert.ok(!io.files.has(paths.post('public', post.id)));
  assert.ok(sealed.assets[0].key);
  const stored = await io.readBytes(paths.vaultAsset(a));
  assert.notDeepEqual(stored.slice(12, 17), bytes, 'stored encrypted');
  assert.deepEqual(await vault.readAsset(sealed.assets[0]), bytes);
  assert.doesNotMatch(await io.readText(paths.post('private', post.id)), /Trip/);
  assert.equal((await vault.readIndex('public')).posts.length, 0);
  assert.equal((await vault.readIndex('private')).posts[0].title, 'Trip');

  const back = await vault.savePost({ ...sealed, tier: 'public', body: 'no more photo' });
  assert.equal(back.assets.length, 0, 'unreferenced attachment pruned');
  assert.ok(!io.files.has(paths.vaultAsset(a)));

  await vault.deletePost(post.id);
  assert.equal((await vault.list()).length, 0);
  assert.ok(!io.files.has(paths.post('public', post.id)));
});

test('vault validates dates and rejects unsafe file types', async () => {
  const { vault } = await makeVault();
  await assert.rejects(vault.savePost({ title: 'x', date: '2020-13-01' }), /Invalid date/);
  assert.throws(() => vault.prepareAsset({ name: 'x.svg', size: 1 }, 'public'), /Unsupported/);
  assert.throws(() => vault.prepareAsset({ name: 'x.html', size: 1 }, 'public'), /Unsupported/);
  const p = await vault.savePost({ title: 'Old memory', date: '1998' });
  assert.equal(p.date, '1998');
});

// ---------- github adapter ----------
test('GitHubIO stages writes and publishes one atomic commit', async (t) => {
  const { GitHubIO } = await import('../assets/js/github.js');
  const calls = [];
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url).replace('https://api.github.com/repos/o/r', '');
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push([opts.method || 'GET', u, body]);
    const ok = (d) => new Response(JSON.stringify(d), { headers: { 'content-type': 'application/json' } });
    if (u.startsWith('/contents/data/public/index.json')) return new Response('{"v":1,"posts":[]}');
    if (u.startsWith('/contents/')) return new Response('{"message":"Not Found"}', { status: 404 });
    if (u === '/git/ref/heads/main') return ok({ object: { sha: 'HEAD' } });
    if (u === '/git/commits/HEAD') return ok({ sha: 'HEAD', tree: { sha: 'T0' } });
    if (u.startsWith('/git/trees/T0')) return ok({ tree: [{ path: 'media/public/old.jpg' }] });
    if (u === '/git/blobs') return ok({ sha: `B${calls.length}` });
    if (u === '/git/trees') return ok({ sha: 'T1' });
    if (u === '/git/commits') return ok({ sha: 'C1' });
    if (u === '/git/refs/heads/main') return ok({});
    throw new Error(`unexpected ${u}`);
  };
  const io = new GitHubIO({ owner: 'o', name: 'r', branch: 'main', token: 'x' });
  assert.equal(await io.readText('data/public/index.json'), '{"v":1,"posts":[]}');
  assert.equal(await io.readText('missing.json'), null);
  await io.write('a.json', '{}');
  await io.write('media/public/x.png', new Uint8Array([1, 2]));
  await io.remove('media/public/old.jpg');
  await io.remove('media/public/never-existed.jpg');
  assert.equal(await io.readText('a.json'), '{}', 'reads see staged writes');
  assert.equal(await io.commit('msg'), 'C1');
  const tree = calls.find((c) => c[1] === '/git/trees' && c[0] === 'POST')[2].tree;
  assert.deepEqual(tree.map((e) => [e.path, e.sha === null]), [['a.json', false], ['media/public/x.png', false], ['media/public/old.jpg', true]]);
  assert.equal(calls.at(-1)[2].force, false);
  assert.equal(io.dirty, false);
});

// ---------- worker ----------
class MemKV {
  constructor() {
    this.m = new Map();
  }
  async get(k, type) {
    const e = this.m.get(k);
    if (!e) return null;
    return type === 'json' ? JSON.parse(e.value) : e.value;
  }
  async getWithMetadata(k) {
    const e = this.m.get(k);
    return { value: e?.value ?? null, metadata: e?.metadata ?? null };
  }
  async put(k, value, opts = {}) {
    this.m.set(k, { value, metadata: opts.metadata ?? null });
  }
  async delete(k) {
    this.m.delete(k);
  }
  async list({ prefix = '' } = {}) {
    return { keys: [...this.m].filter(([k]) => k.startsWith(prefix)).map(([name, e]) => ({ name, metadata: e.metadata })), list_complete: true };
  }
}

test('worker: codes, sessions, protected decryption, revocation, guestbook', async (t) => {
  const { io, vault, raw } = await makeVault();
  const img = new Uint8Array([9, 8, 7, 6]);
  const asset = await vault.addAsset(img, { name: 'p.png' }, 'protected');
  const prot = await vault.savePost({ title: 'Family notes', date: '2015-02-03', tier: 'protected', body: `![x](media:${asset.id})`, cover: `media:${asset.id}`, assets: [asset] });
  const priv = await vault.savePost({ title: 'Diary', date: '2016', tier: 'private', body: 'secret' });

  const realFetch = globalThis.fetch;
  const vaultApi = 'https://api.github.com/repos/canvito/canvito-vault/contents/';
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith(vaultApi)) return realFetch(url, opts);
    assert.equal(opts.headers.Authorization, 'Bearer vault-read-token', 'worker reads the private repo with its token');
    assert.equal(opts.headers.Accept, 'application/vnd.github.raw');
    const b = await io.readBytes(u.slice(vaultApi.length).split('?')[0]);
    return b ? new Response(b) : new Response('nf', { status: 404 });
  };
  t.after(() => (globalThis.fetch = realFetch));

  const env = {
    KV: new MemKV(), SESSION_SECRET: 'sess', ADMIN_TOKEN: 'admin-token', PROTECTED_KEY: raw.protected,
    VAULT_REPO: 'canvito/canvito-vault', VAULT_TOKEN: 'vault-read-token', ALLOWED_ORIGINS: 'https://canvito.github.io', ALLOW_NO_TURNSTILE: '1', SESSION_HOURS: '12',
  };
  let ip = 0;
  const call = async (method, path, { body, token, origin, sameIp } = {}) => {
    const headers = { 'CF-Connecting-IP': sameIp ? '1.1.1.1' : `10.0.0.${++ip}` };
    if (body) headers['content-type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (origin) headers.Origin = origin;
    const res = await worker.fetch(new Request(`https://api.test${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, res, data: ct.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer()) };
  };

  assert.equal((await call('GET', '/api/health', { origin: 'https://evil.test' })).status, 403);
  assert.equal((await call('POST', '/api/admin/codes', { body: {}, token: 'nope' })).status, 401);

  const once = (await call('POST', '/api/admin/codes', { body: { type: 'once', label: 'Mom' }, token: 'admin-token' })).data;
  assert.match(once.code, /^\w{4}-\w{4}-\w{4}-\w{4}$/);
  const r1 = await call('POST', '/api/redeem', { body: { code: once.code.toLowerCase() } });
  assert.equal(r1.status, 200);
  assert.equal((await call('POST', '/api/redeem', { body: { code: once.code } })).status, 401, 'one-time code cannot be reused');

  const tok = r1.data.token;
  const idx = (await call('GET', '/api/vault/index', { token: tok })).data;
  assert.deepEqual(idx.posts.map((p) => p.title), ['Family notes']);
  assert.equal(idx.posts[0].coverAsset.key, undefined, 'asset keys never leave the worker');
  const post = (await call('GET', `/api/vault/post/${prot.id}`, { token: tok })).data;
  assert.equal(post.body.includes('media:'), true);
  assert.equal(post.assets[0].key, undefined);
  assert.equal((await call('GET', `/api/vault/post/${priv.id}`, { token: tok })).status, 404, 'private stays sealed');
  const media = await call('GET', `/api/vault/media/${prot.id}/${asset.id}`, { token: tok });
  assert.deepEqual(media.data, img);
  assert.equal(media.res.headers.get('content-type'), 'image/png');
  assert.equal((await call('GET', '/api/vault/index')).status, 401);

  const perm = (await call('POST', '/api/admin/codes', { body: { type: 'permanent', label: 'Friend' }, token: 'admin-token' })).data;
  const ptok = (await call('POST', '/api/redeem', { body: { code: perm.code } })).data.token;
  assert.equal((await call('GET', '/api/session', { token: ptok })).status, 200);
  assert.equal((await call('DELETE', `/api/admin/codes/${perm.id}`, { token: 'admin-token' })).status, 200);
  assert.equal((await call('GET', '/api/session', { token: ptok })).status, 401, 'revocation is immediate');

  const timed = (await call('POST', '/api/admin/codes', { body: { type: 'timed', label: 'Class', hours: 1 }, token: 'admin-token' })).data;
  const ttok = (await call('POST', '/api/redeem', { body: { code: timed.code } })).data;
  assert.ok(ttok.exp <= Date.parse(timed.expiresAt));
  const key = [...env.KV.m.keys()].find((k) => k.startsWith(`code:${timed.id}`));
  env.KV.m.get(key).metadata.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal((await call('GET', '/api/vault/index', { token: ttok.token })).status, 401, 'time-bound access ends at expiry');
  assert.equal((await call('POST', '/api/redeem', { body: { code: timed.code } })).status, 401);

  const codes = (await call('GET', '/api/admin/codes', { token: 'admin-token' })).data.codes;
  assert.deepEqual(codes.map((c) => c.status).sort(), ['expired', 'revoked', 'used']);

  for (let i = 0; i < 8; i++) await call('POST', '/api/redeem', { body: { code: 'WRONGWRONG' }, sameIp: true });
  assert.equal((await call('POST', '/api/redeem', { body: { code: 'WRONGWRONG' }, sameIp: true })).status, 429, 'rate limited');

  assert.equal((await call('POST', '/api/guestbook', { body: { name: 'A', message: 'Hello!' } })).data.pending, true);
  await call('POST', '/api/guestbook', { body: { name: 'B', message: 'For your eyes', private: true } });
  await call('POST', '/api/guestbook', { body: { name: 'Bot', message: 'spam', website: 'http://spam' } });
  const q = (await call('GET', '/api/admin/guestbook', { token: 'admin-token' })).data.queue;
  assert.equal(q.length, 2, 'honeypot submission dropped');
  const pub = q.find((e) => !e.private);
  const prv = q.find((e) => e.private);
  assert.equal((await call('POST', `/api/admin/guestbook/${prv.id}/approve`, { token: 'admin-token' })).status, 400);
  assert.equal((await call('POST', `/api/admin/guestbook/${pub.id}/approve`, { token: 'admin-token' })).status, 200);
  const list = (await call('GET', '/api/guestbook')).data.entries;
  assert.deepEqual(list.map((e) => e.name), ['A']);
});
