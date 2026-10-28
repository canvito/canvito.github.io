#!/usr/bin/env node
// Run the Cloudflare Worker locally on Node with an in-memory KV — no Cloudflare account needed.
// Usage: node tools/dev-worker.mjs [--port 8787] [--site http://localhost:8080]
// Requires `node tools/canvito.mjs login` (uses your cached keys). Turnstile is disabled in this mode.
import http from 'node:http';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../assets/js/crypto.js';
import worker from '../worker/src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const port = Number(arg('port', 8787));
const site = arg('site', 'http://localhost:8080');

const cache = process.env.CANVITO_KEYS || path.join(os.homedir(), '.canvito', `keys-${(await sha256Hex(ROOT.toLowerCase())).slice(0, 10)}.json`);
if (!existsSync(cache)) {
  console.error('No cached keys. Run: node tools/canvito.mjs login');
  process.exit(1);
}
const secrets = JSON.parse(await fs.readFile(cache, 'utf8'));

class MemKV {
  m = new Map();
  async get(k, type) {
    const e = this.m.get(k);
    return e ? (type === 'json' ? JSON.parse(e.value) : e.value) : null;
  }
  async getWithMetadata(k) {
    const e = this.m.get(k);
    return { value: e?.value ?? null, metadata: e?.metadata ?? null };
  }
  async put(k, value, o = {}) {
    this.m.set(k, { value, metadata: o.metadata ?? null });
  }
  async delete(k) {
    this.m.delete(k);
  }
  async list({ prefix = '' } = {}) {
    return { keys: [...this.m].filter(([k]) => k.startsWith(prefix)).map(([name, e]) => ({ name, metadata: e.metadata })), list_complete: true };
  }
}

const env = {
  KV: new MemKV(),
  PROTECTED_KEY: secrets.protected,
  ADMIN_TOKEN: secrets.adminToken,
  SESSION_SECRET: secrets.sessionSecret,
  CONTENT_BASE: `${site}/`,
  ALLOWED_ORIGINS: site,
  ALLOW_NO_TURNSTILE: '1',
  SESSION_HOURS: '12',
  GUESTBOOK_AUTO_APPROVE: '0',
};

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    headers.set('CF-Connecting-IP', req.socket.remoteAddress || '127.0.0.1');
    const r = await worker.fetch(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  })
  .listen(port, () => console.log(`Dev worker on http://localhost:${port} (content from ${site}). Set "workerUrl": "http://localhost:${port}" in config.json while testing.`));
