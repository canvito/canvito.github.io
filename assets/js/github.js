// GitHub REST adapter used by the owner Studio. Reads are always fresh (bypass Pages cache);
// writes are staged in memory and published as ONE atomic commit via the Git Data API.
import { b64encode } from './crypto.js';

const API = 'https://api.github.com';
const te = new TextEncoder();
const td = new TextDecoder();

export class GitHubIO {
  constructor({ owner, name, branch = 'main', token }) {
    Object.assign(this, { owner, name, branch, token });
    this.staged = new Map();
  }

  async api(path, opts = {}) {
    const res = await fetch(`${API}/repos/${this.owner}/${this.name}${path}`, {
      ...opts,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
    });
    if (!res.ok) {
      let msg = `${res.status}`;
      try {
        msg += ` ${(await res.json()).message}`;
      } catch {}
      const err = new Error(`GitHub API error ${msg}`);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  async check() {
    const r = await (await this.api('')).json();
    if (!r.permissions?.push) throw new Error('Token cannot write to this repository (needs Contents: read & write)');
    return r;
  }

  async readBytes(path) {
    if (this.staged.has(path)) {
      const v = this.staged.get(path);
      return v === null ? null : typeof v === 'string' ? te.encode(v) : v;
    }
    try {
      const res = await this.api(`/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(this.branch)}`, {
        headers: { Accept: 'application/vnd.github.raw' },
      });
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async readText(path) {
    const b = await this.readBytes(path);
    return b && td.decode(b);
  }

  async write(path, data) {
    this.staged.set(path, data);
  }

  async remove(path) {
    this.staged.set(path, null);
  }

  get dirty() {
    return this.staged.size > 0;
  }

  async commit(message) {
    if (!this.staged.size) return null;
    const ref = await (await this.api(`/git/ref/heads/${this.branch}`)).json();
    const head = await (await this.api(`/git/commits/${ref.object.sha}`)).json();
    const tree = await (await this.api(`/git/trees/${head.tree.sha}?recursive=1`)).json();
    const existing = new Set(tree.tree.map((t) => t.path));
    const entries = [];
    for (const [path, data] of this.staged) {
      if (data === null) {
        if (existing.has(path)) entries.push({ path, mode: '100644', type: 'blob', sha: null });
        continue;
      }
      const body = typeof data === 'string' ? { content: data, encoding: 'utf-8' } : { content: b64encode(data), encoding: 'base64' };
      const blob = await (await this.api('/git/blobs', { method: 'POST', body: JSON.stringify(body) })).json();
      entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    if (!entries.length) {
      this.staged.clear();
      return null;
    }
    const newTree = await (await this.api('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: head.tree.sha, tree: entries }) })).json();
    const commit = await (
      await this.api('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: newTree.sha, parents: [head.sha] }) })
    ).json();
    await this.api(`/git/refs/heads/${this.branch}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
    this.staged.clear();
    return commit.sha;
  }
}

// Routes each path to the public site repo or the private vault repo; commits each repo that changed.
export class SplitIO {
  constructor(site, vault, isVault) {
    Object.assign(this, { site, vault, isVault });
  }
  pick(p) {
    return this.isVault(p) ? this.vault : this.site;
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
  get dirty() {
    return this.site.dirty || this.vault.dirty;
  }
  async commit(siteMessage, vaultMessage = 'vault: update') {
    const vault = await this.vault.commit(vaultMessage);
    const site = await this.site.commit(siteMessage);
    return site || vault;
  }
}

// Read-only adapter over the published static site (used when no GitHub token is configured).
export class StaticIO {
  constructor(base = './') {
    this.base = base;
  }
  async readBytes(path) {
    const res = await fetch(this.base + path, { cache: 'no-cache' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  async readText(path) {
    const b = await this.readBytes(path);
    return b && td.decode(b);
  }
  async write() {
    throw new Error('Read-only: add a GitHub token in Studio → Settings to publish');
  }
  async remove() {
    throw new Error('Read-only');
  }
}
