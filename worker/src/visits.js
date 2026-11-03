// Private visitor counter, stored in Cloudflare D1 (binding DB). Schema: worker/schema.sql.
// Privacy: raw IP addresses are never stored, only a keyed hash that needs SESSION_SECRET to recreate.
import { sha256Hex, verifyToken } from '../../assets/js/crypto.js';

const VID_RE = /^[a-z0-9]{8,40}$/;
const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|preview|fetch|curl|wget|python|httpclient|java\/|go-http|axios|node-fetch|monitor|scan/i;
const HITS_PER_MINUTE = 20;
const MAX_ROWS = 100_000;

const noContent = () => new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);

export function parseUA(ua = '') {
  const device = /ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/i.test(ua) ? 'tablet' : /mobi|iphone|ipod|android|blackberry|phone/i.test(ua) ? 'mobile' : 'desktop';
  const browser = /edg\//i.test(ua) ? 'Edge' : /opr\/|opera/i.test(ua) ? 'Opera' : /samsungbrowser/i.test(ua) ? 'Samsung Internet' : /firefox|fxios/i.test(ua) ? 'Firefox' : /chrome|crios|chromium/i.test(ua) ? 'Chrome' : /safari/i.test(ua) ? 'Safari' : 'Other';
  const os = /windows/i.test(ua) ? 'Windows' : /iphone|ipad|ipod/i.test(ua) ? 'iOS' : /android/i.test(ua) ? 'Android' : /cros/i.test(ua) ? 'ChromeOS' : /mac os x|macintosh/i.test(ua) ? 'macOS' : /linux/i.test(ua) ? 'Linux' : 'Other';
  return { device, browser, os };
}

// Only known page shapes are stored; anything else becomes "#/other", so visitors can't plant arbitrary text in reports.
const PAGE_RE = /^#\/(journal|threads|guestbook|about)?$/;
const POST_RE = /^#\/p\/[a-z0-9][a-z0-9-]{1,63}$/;
export function cleanPath(p) {
  const s = clip(p, 300).split('?')[0];
  if (!/^#?\//.test(s)) return null;
  const h = s.startsWith('#') ? s : `#${s}`;
  if (PAGE_RE.test(h) || POST_RE.test(h)) return h;
  if (/^#\/studio(\/|$)/.test(h)) return '#/studio';
  return '#/other';
}

function refHost(ref, ownOrigins) {
  try {
    const u = new URL(String(ref));
    if (!/^https?:$/.test(u.protocol) || ownOrigins.includes(u.origin)) return null;
    return u.hostname.replace(/^www\./, '').slice(0, 100);
  } catch {
    return null;
  }
}

export async function recordHit(req, env, allowedOrigins) {
  if (!env.DB || env.VISITOR_COUNTER === '0') return noContent();
  const origin = req.headers.get('Origin');
  const ua = req.headers.get('User-Agent') || '';
  // Only real browsers on the site count: they always send an allowed Origin.
  if (!origin || !allowedOrigins.includes(origin) || BOT_RE.test(ua)) return noContent();
  let body;
  try {
    body = JSON.parse((await req.text()).slice(0, 4096));
  } catch {
    return noContent();
  }
  const vid = String(body.vid || '');
  const path = cleanPath(body.path);
  if (!VID_RE.test(vid) || !path) return noContent();

  const now = Date.now();
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const ipHash = (await sha256Hex(`visit|${env.SESSION_SECRET}|${ip}`)).slice(0, 16);
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM visits WHERE ip_hash = ? AND ts > ?').bind(ipHash, now - 60_000).first();
  if ((recent?.n || 0) >= HITS_PER_MINUTE) return noContent();
  const seen = await env.DB.prepare('SELECT 1 AS x FROM visits WHERE vid = ? LIMIT 1').bind(vid).first();

  let guest = null;
  const tok = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (tok) {
    const s = await verifyToken(env.SESSION_SECRET, tok);
    if (s?.exp > now) guest = clip(s.l, 80) || 'Guest';
  }
  const cf = req.cf || {};
  const { device, browser, os } = parseUA(ua);
  await env.DB.prepare(
    'INSERT INTO visits (ts, vid, ip_hash, path, referrer, country, region, city, device, browser, os, guest, new_visitor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(now, vid, ipHash, path, refHost(body.ref, allowedOrigins), clip(cf.country, 8) || null, clip(cf.region, 60) || null, clip(cf.city, 60) || null, device, browser, os, guest, seen ? 0 : 1)
    .run();
  return noContent();
}

// Owner report data. Live views poll with since_id so only new rows are read.
export async function listVisits(url, env, json) {
  if (!env.DB) return json({ configured: false, rows: [], stats: null });
  const sinceId = Math.max(0, parseInt(url.searchParams.get('since_id') || '0', 10) || 0);
  const from = Math.max(0, parseInt(url.searchParams.get('from') || '0', 10) || 0);
  const { results } = await env.DB.prepare(
    'SELECT id, ts, vid, ip_hash, path, referrer, country, region, city, device, browser, os, guest, new_visitor FROM visits WHERE id > ? AND ts >= ? ORDER BY id LIMIT ?',
  )
    .bind(sinceId, from, MAX_ROWS)
    .all();
  let allTime = null;
  if (url.searchParams.get('totals') === '1') {
    allTime = await env.DB.prepare('SELECT COUNT(*) AS views, COUNT(DISTINCT vid) AS visitors, MIN(ts) AS first FROM visits').first();
  }
  return json({ configured: true, rows: results, truncated: results.length === MAX_ROWS, allTime });
}
