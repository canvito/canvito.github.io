#!/usr/bin/env node
// Full-app smoke test with privacy-boundary checks.
//   npm run smoke              local: this checkout, served on localhost, plus the local dev Worker (tools/dev-worker.mjs)
//   npm run smoke -- --live    live:  https://<CNAME> and the deployed Worker (no writes except one temporary access code)
// Needs the owner key cache (`node tools/canvito.mjs login`) and the vault clone next to this repo. The keys are used
// only inside this process, to learn what must NOT leak (protected/private text, ids, tags). Failures name the entry
// by tier and position, never by its content. Browser: installed Edge by default (SMOKE_CHANNEL=chrome to change).
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { importAesKey, signToken, hashCode, sha256Hex } from '../assets/js/crypto.js';
import { Vault, isVaultPath } from '../assets/js/vault.js';
import { readKeyCache } from '../tools/keycache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = process.argv.includes('--live');
const CFG = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const results = [];
let section = '';
const check = (pass, name, detail = '') => {
  results.push({ section, name, pass: !!pass, detail });
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${!pass && detail ? `  — ${detail}` : ''}`);
};
const head = (s) => console.log(`\n${(section = s)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- ground truth: what each tier contains ----------
const keyFile = process.env.CANVITO_KEYS || path.join(os.homedir(), '.canvito', `keys-${(await sha256Hex(ROOT.toLowerCase())).slice(0, 10)}.json`);
if (!existsSync(keyFile)) throw new Error('No cached keys. Run: node tools/canvito.mjs login');
const secrets = await readKeyCache(keyFile);
const VAULT_REAL = path.resolve(process.env.CANVITO_VAULT || path.join(ROOT, '..', CFG.vault?.name || 'canvito-vault'));
const keys = { protected: await importAesKey(secrets.protected), private: await importAesKey(secrets.private) };
// Local runs use a temporary copy of the vault with two planted canary entries (one private, one protected), so the
// private-leak probes are never vacuous. The real vault is only read.
let VAULT_DIR = VAULT_REAL;
const tmpDirs = [];
if (!LIVE) {
  VAULT_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'canvito-smoke-'));
  tmpDirs.push(VAULT_DIR);
  for (const d of ['data/vault', 'media/vault']) if (existsSync(path.join(VAULT_REAL, d))) await fs.cp(path.join(VAULT_REAL, d), path.join(VAULT_DIR, d), { recursive: true });
}
const readOnlyIO = {
  async readText(p) {
    const f = path.join(isVaultPath(p) ? VAULT_DIR : ROOT, p);
    return existsSync(f) ? fs.readFile(f, 'utf8') : null;
  },
};
if (!LIVE) {
  const canaryIO = {
    readText: readOnlyIO.readText,
    async readBytes(p) {
      const f = path.join(isVaultPath(p) ? VAULT_DIR : ROOT, p);
      return existsSync(f) ? new Uint8Array(await fs.readFile(f)) : null;
    },
    async write(p, data) {
      if (!isVaultPath(p)) throw new Error(`smoke canary tried to write outside the temp vault: ${p}`);
      await fs.mkdir(path.dirname(path.join(VAULT_DIR, p)), { recursive: true });
      await fs.writeFile(path.join(VAULT_DIR, p), data);
    },
    async remove(p) {
      if (isVaultPath(p)) await fs.rm(path.join(VAULT_DIR, p), { force: true });
    },
  };
  const cv = new Vault(canaryIO, keys);
  await cv.savePost({ id: 'smoke-canary-private', title: 'Canary private Zephyrine lantern notes', date: '2019-03-14', kind: 'reflect', tier: 'private', tags: ['canary-private-tag'], location: 'Quillmere Harbor', summary: 'Private canary summary sentence one. Private canary summary sentence two with marmalade rivers.', body: 'Private canary paragraph about a hidden lighthouse keeper named Orvald who counts seagulls at dawn and never tells anyone.', vi: { title: 'Ghi chép đèn lồng Zephyrine bí mật', summary: 'Câu tóm tắt riêng tư một. Câu hai về dòng sông mứt cam.', body: 'Đoạn văn canary riêng tư về người gác hải đăng Orvald đếm hải âu lúc bình minh.' } });
  await cv.savePost({ id: 'smoke-canary-protected', title: 'Canary protected Bramblewick teaser', date: '2019-03-15', kind: 'give', tier: 'protected', tags: ['canary-protected-tag'], summary: 'Bramblewick teaser sentence is public. The second Bramblewick sentence about velvet turnips stays sealed.', body: 'Protected canary story of a copper kettle orchestra that rehearses inside an abandoned greenhouse every Thursday night.' });
}
const vault = new Vault(readOnlyIO, keys);
const pub = (await vault.readIndex('public')).posts;
const prot = (await vault.readIndex('protected')).posts;
const priv = (await vault.readIndex('private')).posts;

// Same rule as the Worker's /api/sealed-days teaser.
const firstSentence = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  const one = t.match(/^.+?[.!?…](?=\s|$)/)?.[0] || t;
  return one.length > 220 ? `${one.slice(0, 219).trimEnd()}…` : one;
};
const norm = (s) =>
  String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .toLowerCase();
// Distinctive 6-word windows of a text (enough to detect a leak without false positives on common words).
const windows = (text, allowed = '') => {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const out = new Set();
  const step = Math.max(6, Math.floor(words.length / 5));
  for (let i = 0; i + 6 <= words.length; i += step) {
    const w = words.slice(i, i + 6).join(' ');
    if (w.length >= 25 && !norm(allowed).includes(norm(w))) out.add(w);
  }
  return [...out].slice(0, 6);
};
const publicTags = new Set(pub.flatMap((m) => m.tags || []));
// needles: [{ label, text }] that must never be visible to a public visitor (and, for private, to a guest either).
const needlesFor = (m, tier, i) => {
  const label = `${tier} entry #${i + 1}`;
  const n = [{ label: `${label} id`, text: m.id }];
  const teaser = tier === 'protected' ? [m.title, firstSentence(m.summary), m.vi?.title, firstSentence(m.vi?.summary)].join(' | ') : '';
  if (tier === 'private') {
    for (const t of [m.title, m.vi?.title]) if (t && t.length >= 8) n.push({ label: `${label} title`, text: t });
    for (const w of windows(`${m.summary || ''}`)) n.push({ label: `${label} summary`, text: w });
    for (const w of windows(m.vi?.summary)) n.push({ label: `${label} VI summary`, text: w });
  } else {
    const rest = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(firstSentence(s).length);
    for (const w of windows(rest(m.summary), teaser)) n.push({ label: `${label} summary beyond the teaser`, text: w });
    for (const w of windows(rest(m.vi?.summary), teaser)) n.push({ label: `${label} VI summary beyond the teaser`, text: w });
  }
  for (const w of windows(m.excerpt, teaser)) n.push({ label: `${label} body`, text: w });
  for (const w of windows(m.vi?.excerpt, teaser)) n.push({ label: `${label} VI body`, text: w });
  if (m.location && m.location.length >= 4) n.push({ label: `${label} location`, text: m.location });
  if (m.coverAsset?.id) n.push({ label: `${label} media id`, text: m.coverAsset.id });
  return n;
};
const privNeedles = priv.flatMap((m, i) => needlesFor(m, 'private', i));
const protNeedles = prot.flatMap((m, i) => needlesFor(m, 'protected', i));
const sealedOnlyTags = new Set([...prot, ...priv].flatMap((m) => m.tags || []).filter((t) => !publicTags.has(t)));
const privTitles = priv.flatMap((m) => [m.title, m.vi?.title]).filter((t) => t && t.length >= 8);
const protTitles = prot.flatMap((m) => [m.title, m.vi?.title]).filter((t) => t && t.length >= 8);
const leaks = (hay, needles) => {
  const h = norm(hay);
  return [...new Set(needles.filter((n) => h.includes(norm(n.text))).map((n) => n.label))];
};
const listedProt = prot.filter((m) => m.kind !== 'page' && /^\d{4}-\d{2}-\d{2}/.test(m.date));

console.log(`Smoke test (${LIVE ? 'LIVE' : 'local, with canary entries'}) — ${pub.length} public, ${prot.length} protected, ${priv.length} private entries; ${privNeedles.length + protNeedles.length} leak probes.`);
if (!priv.length) console.log('  note: no private entries, so private-leak probes are vacuous (local runs add a canary).');

// ---------- targets ----------
let SITE, API;
const procs = [];
const servers = [];
async function freePort() {
  const s = http.createServer().listen(0);
  await new Promise((r) => s.once('listening', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
if (LIVE) {
  SITE = `https://${readFileSync(path.join(ROOT, 'CNAME'), 'utf8').trim()}`;
  API = CFG.workerUrl.replace(/\/$/, '');
} else {
  const [sp, wp] = [await freePort(), await freePort()];
  SITE = `http://localhost:${sp}`;
  API = `http://localhost:${wp}`;
  // Serve this checkout like GitHub Pages would (only tracked, non-ignored files), pointed at the local Worker.
  const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean));
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain' };
  const srv = http.createServer(async (req, res) => {
    let rel = decodeURIComponent(new URL(req.url, SITE).pathname).replace(/^\/+/, '') || 'index.html';
    if (!tracked.has(rel)) return res.writeHead(404).end('not found');
    let body = await fs.readFile(path.join(ROOT, rel));
    if (rel === 'config.json') body = JSON.stringify({ ...JSON.parse(body), workerUrl: API, turnstileSiteKey: '' });
    if (rel.endsWith('.html')) body = String(body).replace(CFG.workerUrl, `${CFG.workerUrl} ${API}`);
    res.writeHead(200, { 'content-type': TYPES[path.extname(rel)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  });
  srv.listen(sp, '127.0.0.1');
  servers.push(srv);
  const w = spawn(process.execPath, ['tools/dev-worker.mjs', '--port', String(wp), '--site', SITE], { cwd: ROOT, env: { ...process.env, CANVITO_VAULT: VAULT_DIR }, stdio: 'ignore' });
  procs.push(w);
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${API}/api/health`, { headers: { Origin: SITE } }).then((r) => r.ok).catch(() => false)) break;
    await sleep(200);
  }
}
const ORIGIN = SITE;
const call = async (p, { method = 'GET', token, body, origin = ORIGIN } = {}) => {
  const headers = { Origin: origin };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const r = await fetch(API + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: r.status, headers: r.headers, text, data };
};

let codeId = null;
const extraCodes = [];
let browser;
try {
  // ---------- 1. repository ----------
  head('1. Public repository (what anyone can clone)');
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const forbidden = files.filter((f) => isVaultPath(f) || /^(drafts|notes|\.canvito)\//.test(f) || /\.local\.json$|keys-.*\.json$|\.dev\.vars$/.test(f));
  check(!forbidden.length, 'no vault data, keyring, drafts or key files are tracked', forbidden.join(', '));
  const textFiles = files.filter((f) => /\.(json|js|mjs|html|css|md|txt|toml|yml|yaml)$/.test(f) && !f.startsWith('tests/'));
  let repoText = '';
  for (const f of textFiles) repoText += `\n${await fs.readFile(path.join(ROOT, f), 'utf8')}`;
  check(!leaks(repoText, privNeedles).length, 'tracked files contain no private-entry text', leaks(repoText, privNeedles).join('; '));
  check(!leaks(repoText, protNeedles).length, 'tracked files contain no protected-entry text beyond teasers', leaks(repoText, protNeedles).join('; '));
  const pubIdx = JSON.parse(await fs.readFile(path.join(ROOT, 'data/public/index.json'), 'utf8'));
  check(pubIdx.posts.every((m) => m.tier === 'public'), 'public index lists only public entries');
  const logMsgs = execFileSync('git', ['log', '--all', '--format=%B'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  check(!leaks(logMsgs, [...privTitles, ...protTitles].map((text, i) => ({ label: `sealed title #${i + 1}`, text }))).length, 'commit messages never name protected/private entries');
  const history = execFileSync('git', ['log', '--all', '-p', '--no-color', '--', 'data', 'config.json', 'index.html', '404.html'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 29 });
  check(!leaks(history, privNeedles).length, 'git history never contained private-entry text', leaks(history, privNeedles).join('; '));
  check(!/data\/vault\/|keyring\.json/.test(execFileSync('git', ['log', '--all', '--name-only', '--format='], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })), 'git history never contained vault files or the keyring');

  // ---------- 2. static site ----------
  head(`2. Static site over HTTP (${SITE})`);
  for (const p of ['data/vault/index-protected.json', 'data/vault/index-private.json', 'data/keyring.json', 'media/vault/x.bin', '.git/config', 'drafts/', 'worker/.dev.vars']) {
    const r = await fetch(`${SITE}/${p}`);
    check(r.status === 404, `${p} is not served (${r.status})`);
  }
  const html = await (await fetch(`${SITE}/`)).text();
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] || '';
  const scriptSrc = csp.match(/script-src([^;]*)/)?.[1] || '';
  check(csp && !/unsafe-(inline|eval)/.test(scriptSrc) && /object-src 'none'/.test(csp) && /base-uri 'self'/.test(csp), 'CSP blocks inline/eval scripts, plugins and base hijacking');
  check(/name="referrer" content="strict-origin-when-cross-origin"/.test(html), 'referrer policy is strict-origin-when-cross-origin');
  const robots = await (await fetch(`${SITE}/robots.txt`)).text();
  check(/GPTBot[\s\S]*Disallow: \//.test(robots) && /Disallow: \/data\//.test(robots), 'robots.txt blocks AI crawlers and data/ scraping');
  let siteText = html;
  for (const p of ['config.json', 'data/public/index.json', ...pub.map((m) => `data/public/${m.id}.json`)]) siteText += await (await fetch(`${SITE}/${p}`)).text();
  check(!leaks(siteText, [...privNeedles, ...protNeedles]).length, 'served pages and data contain no sealed text', leaks(siteText, [...privNeedles, ...protNeedles]).join('; '));

  // ---------- 3. Worker API, anonymous ----------
  head(`3. Worker API without access (${API})`);
  check((await call('/api/health')).status === 200, 'health answers the site origin');
  const evil = await call('/api/health', { origin: 'https://evil.example' });
  check(evil.status === 403 && !evil.headers.get('access-control-allow-origin'), 'other origins are refused (403, no CORS header)');
  const pid = prot[0]?.id || 'none00000000';
  const vid = priv[0]?.id || 'none00000000';
  for (const [p, what] of [['/api/vault/index', 'protected index'], [`/api/vault/post/${pid}`, 'a protected entry'], [`/api/vault/post/${vid}`, 'a private entry'], [`/api/vault/media/${pid}/abcdefabcdef`, 'protected media'], ['/api/session', 'a session']])
    check((await call(p)).status === 401, `no token: ${what} → 401`);
  const forged = `${Buffer.from(JSON.stringify({ c: 'x'.repeat(64), exp: Date.now() + 3.6e6 })).toString('base64url')}.${'A'.repeat(43)}`;
  check((await call('/api/vault/index', { token: forged })).status === 401, 'forged guest token → 401');
  for (const p of ['/api/admin/codes', '/api/admin/visits', '/api/admin/guestbook']) check((await call(p, { token: 'not-the-admin-token' })).status === 401, `bad admin token: ${p} → 401`);
  const sd = await call('/api/sealed-days');
  const days = sd.data?.days || {};
  const teasers = Object.values(days).flat();
  check(sd.status === 200 && teasers.every((x) => Object.keys(x).every((k) => ['title', 'kind', 'summary', 'vi'].includes(k)) && Object.keys(x.vi || {}).every((k) => ['title', 'summary'].includes(k))), 'sealed-days teasers carry only title, kind, one sentence (EN/VI)');
  check(teasers.length === listedProt.length, `sealed-days lists every dated protected entry and nothing else (${teasers.length}/${listedProt.length})`);
  check(listedProt.every((m) => (days[m.date.slice(0, 10)] || []).some((x) => !x.title || (x.title === m.title && x.summary === firstSentence(m.summary)))), 'each teaser is exactly the title + first summary sentence');
  check(!leaks(sd.text, privNeedles).length && !leaks(sd.text, protNeedles).length, 'sealed-days leaks no private text and no protected body/ids/tags', [...leaks(sd.text, privNeedles), ...leaks(sd.text, protNeedles)].join('; '));
  check(![...sealedOnlyTags].some((t) => sd.text.includes(`"${t}"`)), 'sealed-days reveals no sealed tags');
  if (LIVE) {
    const r1 = await call('/api/redeem', { method: 'POST', body: { code: 'AAAA-BBBB-CCCC-DDDD' } });
    const r2 = await call('/api/redeem', { method: 'POST', body: { code: 'AAAA-BBBB-CCCC-DDDD', turnstileToken: 'forged-token' } });
    check(r1.status === 400 && r2.status === 403, `redeem needs a real Turnstile pass: none → 400, forged → 403 (got ${r1.status}, ${r2.status})`);
    const g1 = await call('/api/guestbook', { method: 'POST', body: { name: 'smoke', message: 'smoke' } });
    const g2 = await call('/api/guestbook', { method: 'POST', body: { name: 'smoke', message: 'smoke', turnstileToken: 'forged-token' } });
    check(g1.status === 400 && g2.status === 403, `guestbook needs a real Turnstile pass: none → 400, forged → 403 (got ${g1.status}, ${g2.status})`);
  } else check((await call('/api/redeem', { method: 'POST', body: { code: 'AAAA-BBBB-CCCC-DDDD' } })).status === 401, 'wrong access code → 401');

  // ---------- 4. guest scope ----------
  head('4. Guest access (access code)');
  const created = await call('/api/admin/codes', { method: 'POST', token: secrets.adminToken, body: { type: LIVE ? 'timed' : 'once', hours: 1, label: 'Smoke test' } });
  check((created.status === 200 || created.status === 201) && !!created.data?.code, 'owner can create a temporary code', `status ${created.status}`);
  codeId = created.data?.id;
  let guest;
  if (LIVE) {
    // Turnstile blocks scripted redemption on the live site, so sign the session the Worker would issue.
    const exp = Date.now() + 3_600_000;
    guest = { token: await signToken(secrets.sessionSecret, { c: await hashCode(created.data.code), exp, l: 'Smoke test' }), exp, label: 'Smoke test', type: 'timed' };
  } else {
    const r = await call('/api/redeem', { method: 'POST', body: { code: created.data.code } });
    check(r.status === 200 && (await call('/api/redeem', { method: 'POST', body: { code: created.data.code } })).status === 401, 'one-time code works once, then never again');
    guest = { token: r.data.token, exp: r.data.exp, label: r.data.label, type: r.data.type };
  }
  const gi = await call('/api/vault/index', { token: guest.token });
  const protIds = new Set(prot.map((m) => m.id));
  check(gi.status === 200 && gi.data.posts.every((m) => protIds.has(m.id)) && gi.data.posts.length === prot.length, 'guest index = exactly the protected entries');
  check(!leaks(gi.text, privNeedles).length, 'guest index contains no private text');
  check(!gi.data.posts.some((m) => m.coverAsset?.key), 'media keys never leave the Worker');
  if (priv[0]) check((await call(`/api/vault/post/${priv[0].id}`, { token: guest.token })).status === 404, 'guest asking for a private entry → 404');
  if (prot[0]) {
    const gp = await call(`/api/vault/post/${prot[0].id}`, { token: guest.token });
    check(gp.status === 200 && !(gp.data.assets || []).some((a) => a.key), 'guest reads a protected entry (no media keys)');
    const a = (gp.data.assets || [])[0];
    if (a) {
      const media = await fetch(`${API}/api/vault/media/${prot[0].id}/${a.id}`, { headers: { Origin: ORIGIN, Authorization: `Bearer ${guest.token}` } });
      check(media.status === 200 && media.headers.get('cache-control') === 'no-store', 'decrypted media is served with no-store');
    }
  }
  const tampered = guest.token.slice(0, -2) + (guest.token.endsWith('AA') ? 'BB' : 'AA');
  check((await call('/api/vault/index', { token: tampered })).status === 401, 'tampered guest token → 401');

  // ---------- 5. browser ----------
  const { createRequire } = await import('node:module');
  let chromium;
  try {
    ({ chromium } = createRequire(import.meta.url)('playwright-core'));
  } catch {
    throw new Error('playwright-core is missing: run npm install');
  }
  browser = await chromium.launch({ channel: process.env.SMOKE_CHANNEL || 'msedge' });
  const allowedHosts = new Set([new URL(SITE).host, new URL(API).host, 'challenges.cloudflare.com']);
  const SITE_HOST = new URL(SITE).host;
  const allHosts = (h) => allowedHosts.has(h) || /(^|\.)(youtube-nocookie\.com|vimeo\.com|loom\.com|google\.com|ytimg\.com|vimeocdn\.com)$/.test(h);

  async function session(label, setup) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    // Never count smoke-test page views in the visitor counter.
    await ctx.addInitScript(() => localStorage.setItem('canvito.notrack', '1'));
    if (setup) await ctx.addInitScript(setup.script, setup.arg);
    const page = await ctx.newPage();
    const s = { ctx, page, net: [], hosts: new Set(), errors: [] };
    page.on('pageerror', (e) => s.errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/Turnstile|challenges\.cloudflare|net::ERR|Failed to load resource/.test(m.text()) && s.errors.push(m.text()));
    page.on('request', (r) => r.url().startsWith('http') && s.hosts.add(new URL(r.url()).host));
    page.on('response', async (r) => {
      const ct = r.headers()['content-type'] || '';
      if (/json|text|javascript/.test(ct)) s.net.push(await r.text().catch(() => ''));
    });
    s.go = async (h) => {
      await page.goto(`${SITE}/${h}`, { waitUntil: 'load' });
      await page.waitForFunction(() => !document.querySelector('#app > .loading'), null, { timeout: 15000 }).catch(() => {});
      await sleep(LIVE ? 1500 : 700);
    };
    s.dom = async () => page.evaluate(() => document.documentElement.outerHTML + '\n' + document.body.innerText);
    return s;
  }
  const routes = [
    '#/', '#/journal', '#/threads', '#/about', '#/guestbook', '#/studio',
    '#/journal?tier=private', '#/journal?tier=protected', '#/journal?q=tier%3Aprivate',
    ...pub.filter((m) => m.kind !== 'page').map((m) => `#/p/${m.id}`),
    ...listedProt.map((m) => `#/journal?q=${encodeURIComponent(`date:${m.date.slice(0, 10)}`)}`),
    ...[...prot, ...priv].map((m) => `#/p/${m.id}`),
    ...[...sealedOnlyTags].map((t) => `#/journal?tag=${encodeURIComponent(t)}`),
    ...priv.map((m) => `#/journal?q=${encodeURIComponent(String(m.title).split(' ').slice(0, 3).join(' '))}`),
  ];
  async function crawl(s, lang) {
    let text = '';
    if (lang === 'vi') await s.page.evaluate(() => localStorage.setItem('canvito.lang', 'vi'));
    for (const r of routes) {
      await s.go(r);
      text += await s.dom();
    }
    if (lang === 'vi') await s.page.evaluate(() => localStorage.removeItem('canvito.lang'));
    return text;
  }
  const visibleTags = async (s) => {
    await s.go('#/threads');
    const a = await s.page.$$eval('.cloud a, .filters a, .pinned-threads a', (els) => els.map((e) => e.textContent.replace(/^[#📌\s]+/, '').replace(/\s*\d+$/, '').trim()));
    await s.go('#/journal');
    const b = await s.page.$$eval('.tags a, .tags span', (els) => els.map((e) => e.textContent.replace(/^#/, '').trim()));
    return [...a, ...b];
  };

  head('5. Browser — public visitor (every view, EN + VI)');
  const P = await session('public');
  const pubText = (await crawl(P, 'en')) + (await crawl(P, 'vi'));
  const pubAll = pubText + P.net.join('\n');
  check(!leaks(pubAll, privNeedles).length, 'no private text in any page or network response', leaks(pubAll, privNeedles).join('; '));
  check(!leaks(pubAll, protNeedles).length, 'no protected body, ids, media or extra summary in any page or response', leaks(pubAll, protNeedles).join('; '));
  check(!(await visibleTags(P)).some((t) => sealedOnlyTags.has(t)), 'threads and tag chips show no sealed-only tags');
  const badHosts = [...P.hosts].filter((h) => !allHosts(h));
  check(!badHosts.length, 'the page talks only to the site, the Worker and Turnstile', badHosts.join(', '));
  const store = await P.page.evaluate(() => Object.keys(localStorage));
  check(store.every((k) => ['canvito.vid', 'canvito.notrack', 'canvito.lang', 'canvito.theme'].includes(k)), 'public browser storage holds no tokens or keys', store.join(', '));
  await P.go('#/journal');
  check((await P.page.locator('.entry.sealed-entry').count()) === listedProt.length, `journal lists every protected teaser (${listedProt.length})`);
  const listedTotal = pub.filter((m) => m.kind !== 'page').length + prot.filter((m) => m.kind !== 'page').length;
  check((await P.page.locator('#dateline').innerText()).includes(`No. ${listedTotal}`), `masthead counts public + protected (${listedTotal})`);
  if (listedProt.length) {
    await P.page.locator('.entry.sealed-entry').first().click();
    await sleep(500);
    check((await P.page.locator('#unlock-form').count()) === 1, 'opening a teaser asks for an access code');
    await P.page.keyboard.press('Escape');
  }
  if (prot[0]) {
    await P.go(`#/p/${prot[0].id}`);
    check(!(await P.page.locator('.prose').count()), 'a protected entry URL shows nothing to the public');
  }
  await P.go('#/studio');
  check(!(await P.page.locator('textarea, input[name=title]').count()), 'the studio (editor) is not available to the public');
  await P.page.setViewportSize({ width: 390, height: 844 });
  for (const r of ['#/', '#/journal']) {
    await P.go(r);
    check(await P.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `mobile: ${r} has no sideways scroll`);
  }
  check(!P.errors.length, 'no page errors', P.errors.slice(0, 3).join(' | '));
  await P.ctx.close();

  head('6. Browser — guest with an access code');
  let G;
  if (LIVE) G = await session('guest', { script: (g) => localStorage.setItem('canvito.guest', g), arg: JSON.stringify(guest) });
  else {
    // Real flow: click a sealed dot, enter the code, land on that day.
    const code2 = await call('/api/admin/codes', { method: 'POST', token: secrets.adminToken, body: { type: 'once', label: 'Smoke UI' } });
    extraCodes.push(code2.data?.id);
    G = await session('guest');
    await G.go('#/');
    if (listedProt[0]) {
      const day = listedProt[0].date.slice(0, 10);
      await G.page.locator(`.year-tabs button[data-year="${day.slice(0, 4)}"]`).click();
      await G.page.locator(`i[data-sealed-day="${day}"]`).click();
      await G.page.fill('#unlock-form input[name=secret]', code2.data.code);
      await G.page.locator('#unlock-form button[type=submit]').click();
      await sleep(1500);
      check(G.page.url().includes(encodeURIComponent(`date:${day}`)), 'sealed dot → code → lands on that day');
    } else {
      await G.page.evaluate((g) => localStorage.setItem('canvito.guest', g), JSON.stringify(guest));
    }
  }
  const gText = await crawl(G, 'en');
  const gAll = gText + G.net.join('\n');
  check(!leaks(gAll, privNeedles).length, 'guest never sees private text', leaks(gAll, privNeedles).join('; '));
  if (protNeedles.some((n) => n.label.endsWith('body'))) check(leaks(gAll, protNeedles.filter((n) => n.label.endsWith('body'))).length > 0, 'guest does see protected bodies (probes are live, not vacuous)');
  await G.go('#/journal');
  const gCount = await G.page.locator('a.entry').count();
  const gSealed = await G.page.locator('.entry.sealed-entry').count();
  check(gSealed === 0 && gCount === listedTotal, 'guest journal: real entries, no teaser duplicates', `${gCount} entries, ${gSealed} teasers, expected ${listedTotal}`);
  check(!(await visibleTags(G)).some((t) => priv.some((m) => m.tags?.includes(t)) && !publicTags.has(t) && !prot.some((m) => m.tags?.includes(t))), 'guest sees no private-only tags');
  await G.page.locator('#access [data-lock]').click();
  await sleep(1200);
  const left = await G.page.evaluate(() => localStorage.getItem('canvito.guest'));
  await G.go('#/journal');
  const afterText = (await G.dom()) + (prot[0] ? '' : '');
  check(!left && !leaks(afterText, protNeedles).length && (await G.page.locator('.entry.sealed-entry').count()) === listedProt.length, '"Leave" clears the session and protected content is gone');
  check(!G.errors.length, 'no page errors', G.errors.slice(0, 3).join(' | '));
  await G.ctx.close();

  // Revocation is immediate.
  if (codeId) {
    await call(`/api/admin/codes/${codeId}?purge=1`, { method: 'DELETE', token: secrets.adminToken });
    codeId = null;
    check((await call('/api/vault/index', { token: guest.token })).status === 401, 'revoked code: its session stops working at once');
  }

  // ---------- 7. guestbook XSS (local only; never posts to the live guestbook) ----------
  if (!LIVE) {
    head('7. Guestbook treats visitor text as text');
    const payload = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>smoke-${Date.now()}`;
    await call('/api/guestbook', { method: 'POST', body: { name: '<b onmouseover=alert(1)>Eve</b>', message: payload } });
    const q = await call('/api/admin/guestbook', { token: secrets.adminToken });
    const e = q.data?.queue?.find((x) => x.message === payload);
    check(!!e, 'new messages wait for approval');
    const before = await call('/api/guestbook');
    check(!before.text.includes('smoke-'), 'unapproved messages are not public');
    if (e) await call(`/api/admin/guestbook/${e.id}/approve`, { method: 'POST', token: secrets.adminToken });
    const X = await session('xss');
    await X.go('#/guestbook');
    await sleep(800);
    const xss = await X.page.evaluate(() => ({ ran: window.__xss, img: !!document.querySelector('img[src="x"]'), b: !!document.querySelector('b[onmouseover]'), shown: document.body.innerText.includes('<img src=x') }));
    check(!xss.ran && !xss.img && !xss.b && xss.shown, 'HTML in names/messages is shown as text and never runs');
    await X.ctx.close();
  }
} catch (e) {
  check(false, `smoke run crashed: ${e.message}`);
} finally {
  for (const id of [codeId, ...extraCodes].filter(Boolean)) await call(`/api/admin/codes/${id}?purge=1`, { method: 'DELETE', token: secrets.adminToken }).catch(() => {});
  await browser?.close();
  for (const p of procs) p.kill();
  for (const s of servers) s.close();
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${failed.length ? '✖' : '✔'} ${results.length - failed.length}/${results.length} checks passed${failed.length ? `; ${failed.length} FAILED:` : '.'}`);
for (const f of failed) console.log(`  [${f.section.split(' ')[0]}] ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
process.exit(failed.length ? 1 : 0);
