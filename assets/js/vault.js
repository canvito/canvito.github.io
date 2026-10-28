// Content store shared by the browser Studio and the Node CLI.
// `io` adapter: { readText(path), readBytes(path), write(path, string|Uint8Array), remove(path) } (paths are repo-relative).
// `keys`: { protected?: CryptoKey, private?: CryptoKey }. Public content needs no key.
import { importAesKey, sealJSON, openJSON, encryptBytes, decryptBytes, randomId, newRawKey } from './crypto.js';
import { plainText, mediaRefs } from './markdown.js';

export const TIERS = ['public', 'protected', 'private'];
export const KINDS = {
  learn: { label: 'Learned', stamp: 'LEARNED' },
  teach: { label: 'Taught', stamp: 'TAUGHT' },
  reflect: { label: 'Reflection', stamp: 'REFLECTED' },
  milestone: { label: 'Milestone', stamp: 'MILESTONE' },
  artifact: { label: 'Artifact', stamp: 'ARTIFACT' },
  page: { label: 'Page', stamp: 'PAGE' },
};

// Backdating supports partial precision: "1998", "2004-09", "2012-05-17", "2012-05-17T08:30".
export const DATE_RE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01])(T([01]\d|2[0-3]):[0-5]\d)?)?)?$/;
export const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const ASSET_ID_RE = /^[a-z0-9]{4,40}$/;

export const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  heic: 'image/heic', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  zip: 'application/zip', doc: 'application/msword', ppt: 'application/vnd.ms-powerpoint', xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  epub: 'application/epub+zip', ipynb: 'application/x-ipynb+json',
};
// SVG/HTML are deliberately excluded: served from the site origin they could execute script.
export const ALLOWED_EXT = new Set(Object.keys(MIME));
export const MAX_ASSET_BYTES = 95 * 1024 * 1024;

export const paths = {
  keyring: 'data/keyring.json',
  index: (tier) => (tier === 'public' ? 'data/public/index.json' : `data/vault/index-${tier}.json`),
  post: (tier, id) => (tier === 'public' ? `data/public/posts/${id}.json` : `data/vault/${id}.json`),
  publicAsset: (a) => `media/public/${a.id}.${a.ext}`,
  vaultAsset: (a) => `media/vault/${a.id}.bin`,
};

export function extOf(name = '', mime = '') {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  let ext = m?.[1];
  if (!ext && mime) ext = Object.keys(MIME).find((k) => MIME[k] === mime);
  if (ext === 'jpeg') ext = 'jpg';
  if (!ext || !ALLOWED_EXT.has(ext)) throw new Error(`Unsupported file type: ${name || mime}`);
  return ext;
}

export function normTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags ?? '').split(',');
  return [...new Set(list.map((t) => String(t).trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-')).filter(Boolean))].slice(0, 30);
}

export function normalizePost(input, existing) {
  const p = { ...(existing || {}), ...input };
  const now = new Date().toISOString();
  const post = {
    id: p.id || randomId(10),
    title: String(p.title ?? '').trim(),
    date: String(p.date ?? '').trim() || now.slice(0, 10),
    kind: KINDS[p.kind] ? p.kind : 'learn',
    tier: TIERS.includes(p.tier) ? p.tier : 'public',
    tags: normTags(p.tags),
    summary: String(p.summary ?? '').trim(),
    cover: String(p.cover ?? '').trim(),
    location: String(p.location ?? '').trim(),
    body: String(p.body ?? ''),
    assets: Array.isArray(p.assets) ? p.assets.filter((a) => a && ASSET_ID_RE.test(a.id) && ALLOWED_EXT.has(a.ext)) : [],
    created: existing?.created || p.created || now,
    updated: now,
  };
  if (!ID_RE.test(post.id)) throw new Error(`Invalid id "${post.id}" (lowercase letters, digits, dashes)`);
  if (!post.title) throw new Error('Title is required');
  if (post.title.length > 200) throw new Error('Title is too long (200 max)');
  if (!DATE_RE.test(post.date)) throw new Error(`Invalid date "${post.date}" (use YYYY, YYYY-MM, YYYY-MM-DD or YYYY-MM-DDTHH:mm)`);
  return post;
}

export function toMeta(post) {
  const coverId = post.cover.startsWith('media:') ? post.cover.slice(6) : null;
  const coverAsset = coverId ? post.assets.find((a) => a.id === coverId) || null : null;
  const text = plainText(post.body);
  return {
    id: post.id,
    title: post.title,
    date: post.date,
    kind: post.kind,
    tier: post.tier,
    tags: post.tags,
    summary: post.summary,
    location: post.location,
    cover: coverId ? '' : post.cover,
    coverAsset,
    excerpt: text.slice(0, 1200),
    words: text ? text.split(' ').length : 0,
    media: post.assets.length + (post.body.match(/^\s*@\[/gm)?.length || 0),
    updated: post.updated,
  };
}

const sortIndex = (posts) => posts.sort((a, b) => (a.date === b.date ? a.title.localeCompare(b.title) : b.date.localeCompare(a.date)));

export class Vault {
  constructor(io, keys = {}) {
    this.io = io;
    this.keys = keys;
    this.cache = {};
  }

  can(tier) {
    return tier === 'public' || !!this.keys[tier];
  }

  key(tier) {
    if (!this.keys[tier]) throw new Error(`Locked: no ${tier} key available`);
    return this.keys[tier];
  }

  async readIndex(tier) {
    if (this.cache[tier]) return this.cache[tier];
    const txt = await this.io.readText(paths.index(tier));
    let idx = { v: 1, posts: [] };
    if (txt) idx = tier === 'public' ? JSON.parse(txt) : await openJSON(this.key(tier), JSON.parse(txt), `index:${tier}`);
    return (this.cache[tier] = idx);
  }

  async writeIndex(tier, idx) {
    sortIndex(idx.posts);
    idx.v = 1;
    idx.updated = new Date().toISOString();
    this.cache[tier] = idx;
    const data = tier === 'public' ? idx : await sealJSON(this.key(tier), idx, `index:${tier}`);
    await this.io.write(paths.index(tier), JSON.stringify(data));
  }

  async list() {
    const all = [];
    for (const t of TIERS) if (this.can(t)) all.push(...(await this.readIndex(t)).posts);
    return sortIndex(all);
  }

  async findTier(id) {
    for (const t of TIERS) {
      if (!this.can(t)) continue;
      if ((await this.readIndex(t)).posts.some((p) => p.id === id)) return t;
    }
    return null;
  }

  async readPost(id, tier) {
    tier ??= await this.findTier(id);
    if (!tier) return null;
    const txt = await this.io.readText(paths.post(tier, id));
    if (!txt) return null;
    const data = JSON.parse(txt);
    return tier === 'public' ? data : openJSON(this.key(tier), data, `post:${id}`);
  }

  prepareAsset({ name, mime, size }, tier) {
    if (size > MAX_ASSET_BYTES) throw new Error(`${name} is too large (${Math.round(size / 1048576)} MB). Host big videos on YouTube/Vimeo (unlisted) and embed the link.`);
    const ext = extOf(name, mime);
    const asset = { id: randomId(12), ext, mime: MIME[ext], name: String(name || `file.${ext}`).split(/[\\/]/).pop().slice(0, 120), size };
    if (tier !== 'public') asset.key = newRawKey();
    return asset;
  }

  async writeAsset(asset, bytes) {
    if (asset.key) {
      const k = await importAesKey(asset.key);
      await this.io.write(paths.vaultAsset(asset), await encryptBytes(k, bytes, `asset:${asset.id}`));
    } else await this.io.write(paths.publicAsset(asset), bytes);
  }

  async readAsset(asset) {
    if (!asset.key) return this.io.readBytes(paths.publicAsset(asset));
    const data = await this.io.readBytes(paths.vaultAsset(asset));
    return data && decryptBytes(await importAesKey(asset.key), data, `asset:${asset.id}`);
  }

  async removeAsset(asset) {
    await this.io.remove(asset.key ? paths.vaultAsset(asset) : paths.publicAsset(asset));
  }

  async addAsset(bytes, info, tier) {
    const asset = this.prepareAsset({ ...info, size: bytes.length }, tier);
    await this.writeAsset(asset, bytes);
    return asset;
  }

  async savePost(input) {
    const prevTier = input.id ? await this.findTier(input.id) : null;
    const prev = prevTier ? await this.readPost(input.id, prevTier) : null;
    const post = normalizePost(input, prev);
    if (!this.can(post.tier)) this.key(post.tier);

    // Keep only assets that the body/cover reference; move any whose storage doesn't match the tier.
    const refs = new Set(mediaRefs(`${post.body}\n${post.cover}`));
    const needVault = post.tier !== 'public';
    const kept = [];
    for (const a of post.assets) {
      if (!refs.has(a.id) || kept.some((k) => k.id === a.id)) continue;
      if (!!a.key === needVault) {
        kept.push(a);
        continue;
      }
      const bytes = await this.readAsset(a);
      if (!bytes) throw new Error(`Attachment ${a.name || a.id} is missing; cannot move it to ${post.tier}`);
      await this.removeAsset(a);
      const moved = { ...a };
      if (needVault) moved.key = newRawKey();
      else delete moved.key;
      await this.writeAsset(moved, bytes);
      kept.push(moved);
    }
    post.assets = kept;
    for (const a of prev?.assets || []) if (!kept.some((k) => k.id === a.id)) await this.removeAsset(a);

    if (prevTier && prevTier !== post.tier) {
      if (paths.post(prevTier, post.id) !== paths.post(post.tier, post.id)) await this.io.remove(paths.post(prevTier, post.id));
      const old = await this.readIndex(prevTier);
      old.posts = old.posts.filter((m) => m.id !== post.id);
      await this.writeIndex(prevTier, old);
    }
    const data = post.tier === 'public' ? JSON.stringify(post, null, 2) : JSON.stringify(await sealJSON(this.key(post.tier), post, `post:${post.id}`));
    await this.io.write(paths.post(post.tier, post.id), data);
    const idx = await this.readIndex(post.tier);
    idx.posts = idx.posts.filter((m) => m.id !== post.id);
    idx.posts.push(toMeta(post));
    await this.writeIndex(post.tier, idx);
    return post;
  }

  async deletePost(id) {
    const tier = await this.findTier(id);
    if (!tier) throw new Error(`No entry with id ${id}`);
    const post = await this.readPost(id, tier);
    for (const a of post?.assets || []) await this.removeAsset(a);
    await this.io.remove(paths.post(tier, id));
    const idx = await this.readIndex(tier);
    idx.posts = idx.posts.filter((m) => m.id !== id);
    await this.writeIndex(tier, idx);
    return post;
  }

  // Re-encrypt every entry (and the index) of a vault tier under a fresh key. Returns the new raw key.
  async rekey(tier) {
    if (tier === 'public') throw new Error('Public tier has no key');
    const idx = await this.readIndex(tier);
    const posts = [];
    for (const m of idx.posts) posts.push(await this.readPost(m.id, tier));
    const raw = newRawKey();
    this.keys[tier] = await importAesKey(raw);
    for (const p of posts) if (p) await this.io.write(paths.post(tier, p.id), JSON.stringify(await sealJSON(this.keys[tier], p, `post:${p.id}`)));
    await this.writeIndex(tier, idx);
    return raw;
  }
}
