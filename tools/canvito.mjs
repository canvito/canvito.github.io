#!/usr/bin/env node
// Canvito CLI — manage the journal from a terminal or an AI agent.
// Run `node tools/canvito.mjs help` for usage.
import { promises as fs, existsSync, createReadStream, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createKeyring, openKeyring, importAesKey, newRawKey, sealJSON, b64urlEncode, randomBytes, sha256Hex } from '../assets/js/crypto.js';
import { Vault, paths, isVaultPath, KINDS, TIERS, MIME, extOf } from '../assets/js/vault.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY_DIR = path.join(os.homedir(), '.canvito');

const HELP = `Canvito CLI

Setup
  init                         Create keyring + encrypted indexes in the vault repo (prompts for passphrase)
  login / logout               Cache / forget decrypted keys on this machine (~/.canvito)
  passwd                       Change the owner passphrase
  worker-secrets [--push] [--turnstile-secret S] [--vault-token T]
                               Print (or push via wrangler) the Cloudflare Worker secrets
  rekey protected              Rotate the protected key (revokes every key ever handed out); re-run worker-secrets --push
  doctor                       Decrypt everything and verify attachments exist
  publish                      Commit & push the vault repo and the site repo (generic messages)

Entries
  list [--tier T] [--kind K] [--tag X] [--q text] [--json]
  show <id> [--json | --out file.md]  Print/export an entry as front-matter Markdown (or JSON)
  put <file.md>                Create/update from a front-matter Markdown file (writes id back into file)
  new --title T [--date D] [--kind K] [--tier T] [--tags a,b] [--summary S]
      [--cover path|url] [--location L] [--body text | --body-file f.md] [--id slug]
  edit <id> [same flags as new]
  delete <id>
  attach <file> [--tier T]     Upload a file, print its media: reference (prefer local paths in put)

Access codes (needs workerUrl in config.json)
  codes list
  codes new [--type once|timed|permanent] [--label L] [--hours N | --expires ISO] [--uses N] [--code CUSTOM]
  codes revoke <id> [--purge]

Guestbook
  guestbook list | approve <id> | delete <id>

Dev
  serve [--port 8080]          Preview the site locally

Values: kind = ${Object.keys(KINDS).join('|')}; tier = ${TIERS.join('|')};
date = YYYY | YYYY-MM | YYYY-MM-DD | YYYY-MM-DDTHH:mm (backdating welcome).
Local file paths in Markdown (![cap](./photo.jpg), @[cap](./talk.pdf)) are uploaded automatically —
encrypted when the entry is protected/private.
Sealed entries + keyring live in the PRIVATE vault repo, cloned next to this repo (../canvito-vault).
Env: CANVITO_PASSPHRASE (skip prompt), CANVITO_KEYS (alternate key cache file), CANVITO_VAULT (vault clone path).`;

// ---------- args ----------
function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      const v = inline !== undefined ? inline : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      flags[k] = flags[k] === undefined ? v : [].concat(flags[k], v);
    } else pos.push(a);
  }
  return { pos, flags };
}

const die = (msg) => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};

// ---------- io ----------
class NodeIO {
  constructor(root) {
    this.root = root;
    this.changed = new Set();
  }
  full(p) {
    const f = path.resolve(this.root, p);
    if (!f.startsWith(this.root)) throw new Error(`Path escapes repo: ${p}`);
    return f;
  }
  async readBytes(p) {
    try {
      return new Uint8Array(await fs.readFile(this.full(p)));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }
  async readText(p) {
    const b = await this.readBytes(p);
    return b && new TextDecoder().decode(b);
  }
  async write(p, data) {
    await fs.mkdir(path.dirname(this.full(p)), { recursive: true });
    await fs.writeFile(this.full(p), data);
    this.changed.add(p);
  }
  async remove(p) {
    await fs.rm(this.full(p), { force: true });
    this.changed.add(p);
  }
}

let vaultDirCache;
function vaultDir() {
  if (vaultDirCache) return vaultDirCache;
  const cfg = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const v = cfg.vault || { owner: 'canvito', name: 'canvito-vault' };
  const dir = path.resolve(process.env.CANVITO_VAULT || path.join(ROOT, '..', v.name));
  if (!existsSync(dir)) die(`Vault repo not found at ${dir}.\n  Clone it: gh repo clone ${v.owner}/${v.name} "${dir}"   (or set CANVITO_VAULT)`);
  return (vaultDirCache = dir);
}
const keyringPath = () => path.join(vaultDir(), paths.keyring);

// Routes sealed paths to the private vault clone and everything else to this (public) repo.
class SplitNodeIO {
  constructor() {
    this.site = new NodeIO(ROOT);
    this.vault = new NodeIO(vaultDir());
  }
  pick(p) {
    return isVaultPath(p) ? this.vault : this.site;
  }
  readBytes(p) {
    return this.pick(p).readBytes(p);
  }
  readText(p) {
    return this.pick(p).readText(p);
  }
  write(p, d) {
    return this.pick(p).write(p, d);
  }
  remove(p) {
    return this.pick(p).remove(p);
  }
  get changed() {
    return new Set([...this.site.changed, ...this.vault.changed]);
  }
}

// ---------- prompts ----------
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(s);
        else if (!/[\r\n]/.test(s)) rl.output.write('•');
        else rl.output.write(s);
      };
    }
    rl.question(question, (ans) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(ans);
    });
  });
}

async function passphrase(confirm = false) {
  if (process.env.CANVITO_PASSPHRASE) return process.env.CANVITO_PASSPHRASE;
  const p = await ask('Owner passphrase: ', { hidden: true });
  if (confirm) {
    if (p.length < 14) die('Use at least 14 characters (a 4–6 word phrase is ideal). The encrypted keyring is public, so strength matters.');
    if ((await ask('Repeat passphrase: ', { hidden: true })) !== p) die('Passphrases do not match');
  }
  return p;
}

// ---------- keys ----------
const readJsonFile = async (f) => JSON.parse(await fs.readFile(f, 'utf8'));
const keyCacheFile = async () => process.env.CANVITO_KEYS || path.join(KEY_DIR, `keys-${(await sha256Hex(ROOT.toLowerCase())).slice(0, 10)}.json`);

async function keyring() {
  const f = keyringPath();
  if (!existsSync(f)) die('No keyring yet. Run: node tools/canvito.mjs init');
  return readJsonFile(f);
}

async function unlockSecrets() {
  const s = await openKeyring(await keyring(), await passphrase());
  if (!s) die('Wrong passphrase');
  return s;
}

async function loadSecrets({ optional = false } = {}) {
  const cache = await keyCacheFile();
  if (existsSync(cache)) return readJsonFile(cache);
  if (process.env.CANVITO_PASSPHRASE) return unlockSecrets();
  if (!existsSync(keyringPath())) {
    if (optional) return {};
    die('No keyring yet. Run: node tools/canvito.mjs init');
  }
  if (optional && !process.stdin.isTTY) return {};
  if (!process.stdin.isTTY) die('Locked. Run `node tools/canvito.mjs login` first or set CANVITO_PASSPHRASE.');
  return unlockSecrets();
}

async function openVault(opts) {
  const s = await loadSecrets(opts);
  const keys = {};
  if (s.protected) keys.protected = await importAesKey(s.protected);
  if (s.private) keys.private = await importAesKey(s.private);
  return { vault: new Vault(new SplitNodeIO(), keys), secrets: s };
}

// ---------- front matter ----------
const FM_KEYS = ['id', 'title', 'date', 'kind', 'tier', 'tags', 'summary', 'cover', 'location'];

function parseFrontMatter(text) {
  const m = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^".*"$|^'.*'$/.test(v)) v = v.slice(1, -1);
    if (kv[1] === 'tags') v = v.replace(/^\[|\]$/g, '').split(',').map((t) => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    meta[kv[1]] = v;
  }
  return { meta, body: m[2] };
}

const yamlStr = (v) => (/^[\w][\w .,/()&+-]*$/.test(v) && !/:\s/.test(v) ? v : JSON.stringify(v));
function toFrontMatter(post) {
  const lines = FM_KEYS.filter((k) => post[k] !== undefined && post[k] !== '' && !(Array.isArray(post[k]) && !post[k].length)).map((k) =>
    k === 'tags' ? `tags: [${post.tags.join(', ')}]` : `${k}: ${yamlStr(String(post[k]))}`,
  );
  return `---\n${lines.join('\n')}\n---\n${post.body.startsWith('\n') ? '' : '\n'}${post.body}`;
}

// Upload local files referenced from Markdown and rewrite them to media: refs.
async function uploadLocalRefs(vault, post, baseDir) {
  const added = [];
  const seen = new Map();
  const upload = async (ref) => {
    if (/^(https?:|mailto:|media:|#|\/\/)/i.test(ref)) return null;
    const file = path.resolve(baseDir, decodeURIComponent(ref));
    if (seen.has(file)) return seen.get(file);
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    const bytes = new Uint8Array(await fs.readFile(file));
    const asset = await vault.addAsset(bytes, { name: path.basename(file), mime: MIME[extOf(file)] }, post.tier);
    added.push(asset);
    console.log(`  ↑ ${path.basename(file)} → media:${asset.id}${asset.key ? ' (encrypted)' : ''}`);
    seen.set(file, `media:${asset.id}`);
    return `media:${asset.id}`;
  };
  const re = /(!?\[[^\]]*\]|@\[[^\]]*\])\(([^)\s]+)((?:\s+"[^"]*")?)\)/g;
  let out = '';
  let last = 0;
  for (const m of post.body.matchAll(re)) {
    out += post.body.slice(last, m.index);
    const r = await upload(m[2]);
    out += r ? `${m[1]}(${r}${m[3]})` : m[0];
    last = m.index + m[0].length;
  }
  post.body = out + post.body.slice(last);
  if (post.cover) post.cover = (await upload(post.cover)) || post.cover;
  return added;
}

function postFromFlags(flags) {
  const p = {};
  for (const k of ['title', 'date', 'kind', 'tier', 'summary', 'cover', 'location', 'id']) if (typeof flags[k] === 'string') p[k] = flags[k];
  if (flags.tags !== undefined) p.tags = String(flags.tags);
  if (typeof flags.body === 'string') p.body = flags.body.replace(/\\n/g, '\n');
  return p;
}

async function save(vault, input, baseDir) {
  const existing = input.id ? await vault.readPost(input.id) : null;
  const draft = { ...(existing || {}), ...input };
  draft.tier = TIERS.includes(draft.tier) ? draft.tier : 'public';
  draft.body = draft.body ?? '';
  const added = await uploadLocalRefs(vault, draft, baseDir);
  draft.assets = [...(existing?.assets || []), ...added];
  const post = await vault.savePost(draft);
  console.log(`✔ ${existing ? 'Updated' : 'Created'} [${post.tier}] ${post.date} “${post.title}”  id=${post.id}`);
  printGitHint(vault);
  return post;
}

function printGitHint(vault) {
  if (vault.io.changed.size) console.log(`  ${vault.io.changed.size} file(s) changed. Publish: node tools/canvito.mjs publish`);
}

// ---------- worker api ----------
async function workerApi(secrets, method, p, body) {
  const cfg = await readJsonFile(path.join(ROOT, 'config.json'));
  if (!cfg.workerUrl) die('config.json has no workerUrl yet (deploy the worker first; see README).');
  if (!secrets.adminToken) die('No admin token in keyring');
  const res = await fetch(cfg.workerUrl.replace(/\/$/, '') + p, {
    method,
    headers: { Authorization: `Bearer ${secrets.adminToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(`Worker: ${data.error || res.status}`);
  return data;
}

// ---------- commands ----------
const commands = {
  help() {
    console.log(HELP);
  },

  async init({ flags }) {
    const f = keyringPath();
    if (existsSync(f) && !flags.force) die('Keyring already exists. (--force would make all existing protected/private entries unreadable.)');
    console.log('Choose your OWNER passphrase. It unlocks private entries and the Studio. It is never stored anywhere.');
    const pass = await passphrase(true);
    const secrets = {
      v: 1,
      protected: newRawKey(),
      private: newRawKey(),
      adminToken: b64urlEncode(randomBytes(32)),
      sessionSecret: b64urlEncode(randomBytes(32)),
      createdAt: new Date().toISOString(),
    };
    const io = new SplitNodeIO();
    await io.write(paths.keyring, JSON.stringify(await createKeyring(pass, secrets), null, 2));
    const vault = new Vault(io, { protected: await importAesKey(secrets.protected), private: await importAesKey(secrets.private) });
    for (const t of ['protected', 'private']) await vault.writeIndex(t, { v: 1, posts: [] });
    if (!existsSync(path.join(ROOT, paths.index('public')))) await vault.writeIndex('public', { v: 1, posts: [] });
    console.log(`✔ Keyring + empty encrypted indexes written to the PRIVATE vault repo at ${vaultDir()}`);
    console.log('Next: node tools/canvito.mjs login   then   node tools/canvito.mjs worker-secrets --push');
  },

  async login() {
    const s = await unlockSecrets();
    const f = await keyCacheFile();
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, JSON.stringify(s), { mode: 0o600 });
    console.log(`✔ Keys cached at ${f}. Run "logout" to remove them.`);
  },

  async logout() {
    await fs.rm(await keyCacheFile(), { force: true });
    console.log('✔ Local key cache removed.');
  },

  async passwd() {
    const s = await unlockSecrets();
    console.log('New passphrase:');
    delete process.env.CANVITO_PASSPHRASE;
    const pass = await passphrase(true);
    await fs.writeFile(keyringPath(), JSON.stringify(await createKeyring(pass, s), null, 2));
    console.log('✔ Passphrase changed. Run: node tools/canvito.mjs publish   (then sign in again on each device with the new passphrase + token)');
  },

  async 'worker-secrets'({ flags }) {
    const s = await loadSecrets();
    const vals = { PROTECTED_KEY: s.protected, ADMIN_TOKEN: s.adminToken, SESSION_SECRET: s.sessionSecret };
    if (typeof flags['turnstile-secret'] === 'string') vals.TURNSTILE_SECRET = flags['turnstile-secret'];
    if (typeof flags['vault-token'] === 'string') vals.VAULT_TOKEN = flags['vault-token'];
    if (!flags.push) {
      for (const [k, v] of Object.entries(vals)) console.log(`${k}=${v}`);
      console.log('\nSet each with: cd worker && npx wrangler secret put NAME   (or re-run with --push)');
      return;
    }
    for (const [k, v] of Object.entries(vals)) {
      await new Promise((resolve, reject) => {
        const p = spawn('npx', ['wrangler', 'secret', 'put', k], { cwd: path.join(ROOT, 'worker'), shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
        p.stdin.end(v);
        p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`wrangler exited ${c} for ${k}`))));
      });
    }
    console.log('✔ Worker secrets pushed.');
  },

  async rekey({ pos }) {
    if (pos[0] !== 'protected' && pos[0] !== 'private') die('Usage: rekey protected|private');
    const pass = await passphrase();
    const s = await openKeyring(await keyring(), pass);
    if (!s) die('Wrong passphrase');
    const vault = new Vault(new SplitNodeIO(), { protected: await importAesKey(s.protected), private: await importAesKey(s.private) });
    s[pos[0]] = await vault.rekey(pos[0]);
    await fs.writeFile(keyringPath(), JSON.stringify(await createKeyring(pass, s), null, 2));
    if (existsSync(await keyCacheFile())) await fs.writeFile(await keyCacheFile(), JSON.stringify(s), { mode: 0o600 });
    console.log(`✔ Re-encrypted ${pos[0]} tier with a new key.`);
    if (pos[0] === 'protected') console.log('Now run: node tools/canvito.mjs worker-secrets --push   and publish (git push).');
  },

  async doctor() {
    const { vault } = await openVault();
    let ok = 0;
    let bad = 0;
    for (const m of await vault.list()) {
      try {
        const p = await vault.readPost(m.id, m.tier);
        if (!p) throw new Error('entry file missing');
        for (const a of p.assets) if (!(await vault.readAsset(a))) throw new Error(`attachment ${a.name} missing`);
        ok++;
      } catch (e) {
        bad++;
        console.log(`✖ ${m.id} ${m.title}: ${e.message}`);
      }
    }
    console.log(`${bad ? '✖' : '✔'} ${ok} healthy, ${bad} broken`);
    if (bad) process.exitCode = 1;
  },

  async list({ flags }) {
    const { vault } = await openVault({ optional: true });
    let rows = await vault.list();
    if (flags.tier) rows = rows.filter((r) => r.tier === flags.tier);
    if (flags.kind) rows = rows.filter((r) => r.kind === flags.kind);
    if (flags.tag) rows = rows.filter((r) => r.tags.includes(String(flags.tag).toLowerCase()));
    if (flags.q) {
      const q = String(flags.q).toLowerCase();
      rows = rows.filter((r) => `${r.title} ${r.summary} ${r.tags.join(' ')} ${r.excerpt}`.toLowerCase().includes(q));
    }
    if (flags.json) return console.log(JSON.stringify(rows, null, 2));
    for (const r of rows) console.log(`${r.date.padEnd(16)} ${r.tier.padEnd(9)} ${r.kind.padEnd(9)} ${r.id.padEnd(12)} ${r.title}`);
    console.log(`(${rows.length} entries)`);
  },

  async show({ pos, flags }) {
    if (!pos[0]) die('Usage: show <id>');
    const { vault } = await openVault({ optional: true });
    const p = await vault.readPost(pos[0]);
    if (!p) die(`No entry ${pos[0]}`);
    if (flags.json) console.log(JSON.stringify({ ...p, assets: p.assets.map(({ key, ...a }) => a) }, null, 2));
    else if (typeof flags.out === 'string') {
      await fs.writeFile(flags.out, toFrontMatter(p), 'utf8');
      console.log(`✔ Wrote ${flags.out}`);
    } else console.log(toFrontMatter(p));
  },

  async put({ pos }) {
    if (!pos[0]) die('Usage: put <file.md>');
    const file = path.resolve(pos[0]);
    const text = await fs.readFile(file, 'utf8');
    const { meta, body } = parseFrontMatter(text);
    const { vault } = await openVault();
    const post = await save(vault, { ...meta, body: body.replace(/^\r?\n/, '') }, path.dirname(file));
    if (!meta.id) {
      const updated = text.replace(/^(\uFEFF?---\r?\n)/, `$1id: ${post.id}\n`);
      if (updated !== text) await fs.writeFile(file, updated);
    }
  },

  async new({ flags }) {
    const { vault } = await openVault();
    const input = postFromFlags(flags);
    if (typeof flags['body-file'] === 'string') input.body = await fs.readFile(flags['body-file'], 'utf8');
    if (input.id && (await vault.findTier(input.id))) die(`Entry ${input.id} already exists (use edit)`);
    await save(vault, input, typeof flags['body-file'] === 'string' ? path.dirname(path.resolve(flags['body-file'])) : process.cwd());
  },

  async edit({ pos, flags }) {
    if (!pos[0]) die('Usage: edit <id> [--flags]');
    const { vault } = await openVault();
    if (!(await vault.findTier(pos[0]))) die(`No entry ${pos[0]}`);
    const input = { ...postFromFlags(flags), id: pos[0] };
    if (typeof flags['body-file'] === 'string') input.body = await fs.readFile(flags['body-file'], 'utf8');
    await save(vault, input, typeof flags['body-file'] === 'string' ? path.dirname(path.resolve(flags['body-file'])) : process.cwd());
  },

  async delete({ pos }) {
    if (!pos[0]) die('Usage: delete <id>');
    const { vault } = await openVault();
    const p = await vault.deletePost(pos[0]);
    console.log(`✔ Deleted “${p?.title ?? pos[0]}”`);
    printGitHint(vault);
  },

  async attach({ pos, flags }) {
    if (!pos[0]) die('Usage: attach <file> [--tier T]');
    const { vault } = await openVault();
    const bytes = new Uint8Array(await fs.readFile(pos[0]));
    const a = await vault.addAsset(bytes, { name: path.basename(pos[0]) }, flags.tier || 'public');
    console.log(JSON.stringify(a));
    console.log(`Reference: media:${a.id}  — include this asset object in the entry's "assets" when saving via JSON.`);
  },

  async codes({ pos, flags }) {
    const s = await loadSecrets();
    const sub = pos[0] || 'list';
    if (sub === 'list') {
      const { codes } = await workerApi(s, 'GET', '/api/admin/codes');
      for (const c of codes)
        console.log(`${c.id}  ${c.status.padEnd(8)} ${c.type.padEnd(9)} uses ${c.uses}${c.maxUses ? `/${c.maxUses}` : ''}  ${c.expiresAt ? `until ${c.expiresAt}` : 'no expiry'}  ${c.label}`);
      console.log(`(${codes.length} codes)`);
    } else if (sub === 'new') {
      const c = await workerApi(s, 'POST', '/api/admin/codes', {
        type: flags.type || 'once', label: flags.label, hours: flags.hours, expiresAt: flags.expires, maxUses: flags.uses, code: flags.code,
      });
      console.log(`✔ Access code for ${c.label}:  ${c.code}`);
      console.log(`  type=${c.type}${c.expiresAt ? ` expires=${c.expiresAt}` : ''}${c.maxUses ? ` maxUses=${c.maxUses}` : ''}  id=${c.id}`);
      console.log('  (The code is shown only once — share it now.)');
    } else if (sub === 'revoke') {
      if (!pos[1]) die('Usage: codes revoke <id>');
      await workerApi(s, 'DELETE', `/api/admin/codes/${pos[1]}${flags.purge ? '?purge=1' : ''}`);
      console.log('✔ Revoked. Active sessions using it stop working immediately.');
    } else die('Usage: codes list|new|revoke');
  },

  async guestbook({ pos }) {
    const s = await loadSecrets();
    const sub = pos[0] || 'list';
    if (sub === 'list') {
      const { queue, published } = await workerApi(s, 'GET', '/api/admin/guestbook');
      console.log(`Queue (${queue.length}):`);
      for (const e of queue) console.log(`  ${e.id} ${e.private ? '[private] ' : ''}${e.createdAt.slice(0, 16)} ${e.name}: ${e.message.slice(0, 100)}`);
      console.log(`Published (${published.length}):`);
      for (const e of published.slice(0, 20)) console.log(`  ${e.id} ${e.createdAt.slice(0, 16)} ${e.name}: ${e.message.slice(0, 100)}`);
    } else if (sub === 'approve' || sub === 'delete') {
      if (!pos[1]) die(`Usage: guestbook ${sub} <id>`);
      await workerApi(s, sub === 'approve' ? 'POST' : 'DELETE', `/api/admin/guestbook/${pos[1]}${sub === 'approve' ? '/approve' : ''}`);
      console.log('✔ Done');
    } else die('Usage: guestbook list|approve|delete');
  },

  publish({ flags }) {
    const git = (dir, args) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) die(`git ${args.join(' ')} failed in ${dir}:\n${r.stderr || r.stdout}`);
      return r.stdout;
    };
    const site = git(ROOT, ['status', '--porcelain']);
    if (/(^|\s)(data\/vault\/|media\/vault\/|data\/keyring\.json)/m.test(site)) die('Sealed files are staged in the PUBLIC repo — refusing to publish. Check .gitignore.');
    const repos = [['vault', vaultDir(), 'vault: update'], ['site', ROOT, typeof flags.message === 'string' ? flags.message : 'journal: update']];
    for (const [name, dir, msg] of repos) {
      if (!git(dir, ['status', '--porcelain']).trim()) {
        console.log(`· ${name}: nothing to publish`);
        continue;
      }
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-q', '-m', msg]);
      git(dir, ['push', '-q']);
      console.log(`✔ ${name} published`);
    }
  },

  serve({ flags }) {
    const port = Number(flags.port) || 8080;
    const types = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', json: 'application/json', svg: 'image/svg+xml', txt: 'text/plain', xml: 'application/xml', ico: 'image/x-icon', ...MIME };
    http
      .createServer((req, res) => {
        let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (p.endsWith('/')) p += 'index.html';
        const f = path.resolve(ROOT, `.${p}`);
        if (!f.startsWith(ROOT) || !existsSync(f) || !statSync(f).isFile() || /[\\/](\.git|worker|tools|tests)[\\/]/.test(f.slice(ROOT.length))) {
          res.writeHead(404).end('Not found');
          return;
        }
        res.writeHead(200, { 'content-type': types[path.extname(f).slice(1)] || 'application/octet-stream', 'cache-control': 'no-cache' });
        // Local preview: allow talking to tools/dev-worker.mjs on localhost.
        if (f.endsWith('index.html')) {
          fs.readFile(f, 'utf8').then((html) => res.end(html.replace("connect-src 'self'", "connect-src 'self' http://localhost:*")));
          return;
        }
        createReadStream(f).pipe(res);
      })
      .listen(port, () => console.log(`Serving ${ROOT} at http://localhost:${port}`));
  },
};

const { pos, flags } = parseArgs(process.argv.slice(2));
const cmd = pos.shift() || 'help';
if (!commands[cmd]) die(`Unknown command "${cmd}". Try: node tools/canvito.mjs help`);
try {
  await commands[cmd]({ pos, flags });
} catch (e) {
  die(e.message);
}
