// Visitor report: aggregation + HTML rendering shared by Studio (live view) and the CLI (standalone HTML file).
import { esc } from './markdown.js';

const DAY = 86_400_000;
const TOP = 12;

export const localTz = () => -new Date().getTimezoneOffset();
const dayKey = (ts, tz) => new Date(ts + tz * 60_000).toISOString().slice(0, 10);

function tally(rows, keyFn, { distinct = false } = {}) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!k) continue;
    const e = m.get(k) || { key: k, views: 0, vids: new Set(), last: 0 };
    e.views++;
    e.vids.add(r.vid);
    e.last = Math.max(e.last, r.ts);
    m.set(k, e);
  }
  return [...m.values()]
    .map((e) => ({ key: e.key, views: e.views, visitors: e.vids.size, last: e.last }))
    .sort((a, b) => (distinct ? b.visitors - a.visitors : b.views - a.views) || b.views - a.views);
}

function totals(rows) {
  const vids = new Set();
  const newVids = new Set();
  for (const r of rows) {
    vids.add(r.vid);
    if (r.new_visitor) newVids.add(r.vid);
  }
  return { views: rows.length, visitors: vids.size, newVisitors: newVids.size, returning: vids.size - newVids.size };
}

// rows: visit records from /api/admin/visits; from: range start (ms, 0 = all time); tz: minutes east of UTC.
export function aggregate(rows, { from = 0, now = Date.now(), tz = localTz(), allTime = null } = {}) {
  rows = rows.filter((r) => r.ts >= from).sort((a, b) => a.ts - b.ts);
  const todayKey = dayKey(now, tz);
  const start = from || rows[0]?.ts || now;
  const daily = [];
  const byDay = new Map(tally(rows, (r) => dayKey(r.ts, tz)).map((d) => [d.key, d]));
  for (let t = start, i = 0; i < 1000; t += DAY, i++) {
    const k = dayKey(t, tz);
    if (daily.length && daily[daily.length - 1].day === k) continue;
    daily.push({ day: k, views: byDay.get(k)?.views || 0, visitors: byDay.get(k)?.visitors || 0 });
    if (k >= todayKey) break;
  }
  return {
    from,
    now,
    tz,
    range: totals(rows),
    today: totals(rows.filter((r) => dayKey(r.ts, tz) === todayKey)),
    allTime,
    daily,
    pages: tally(rows, (r) => r.path),
    countries: tally(rows, (r) => r.country, { distinct: true }),
    cities: tally(rows, (r) => (r.city ? `${r.city}${r.country ? `, ${r.country}` : ''}` : null), { distinct: true }),
    referrers: tally(rows, (r) => r.referrer, { distinct: true }),
    devices: tally(rows, (r) => r.device, { distinct: true }),
    browsers: tally(rows, (r) => r.browser, { distinct: true }),
    os: tally(rows, (r) => r.os, { distinct: true }),
    guests: tally(rows, (r) => r.guest),
    recent: rows.slice(-100).reverse(),
  };
}

export function pageLabel(path, titleOf = () => null) {
  const p = String(path || '');
  const m = p.match(/^#\/p\/([a-z0-9-]+)/);
  if (m) return titleOf(m[1]) || `Entry ${m[1]}`;
  const names = { '#/': 'Front page', '#/journal': 'Journal', '#/threads': 'Threads', '#/guestbook': 'Guestbook', '#/about': 'About' };
  if (names[p]) return names[p];
  if (p.startsWith('#/studio')) return 'Studio';
  return p;
}

const fmtTime = (ts) => new Date(ts).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const n = (x) => Number(x || 0).toLocaleString();

function card(label, t) {
  if (!t) return '';
  return `<div class="vr-card"><div class="vr-card-label">${esc(label)}</div><b>${n(t.visitors)}</b><span>visitors</span><div class="vr-card-sub">${n(t.views)} page views${
    t.newVisitors !== undefined ? ` · ${n(t.newVisitors)} new · ${n(t.returning)} returning` : ''
  }</div></div>`;
}

function chart(daily) {
  if (!daily.length) return '';
  const max = Math.max(1, ...daily.map((d) => d.views));
  const w = 1000;
  const h = 160;
  const bw = w / daily.length;
  const bars = daily
    .map((d, i) => {
      const vh = (d.views / max) * (h - 10);
      const uh = (d.visitors / max) * (h - 10);
      const x = (i * bw).toFixed(2);
      const bwi = Math.max(1, bw * 0.78).toFixed(2);
      return `<g><title>${esc(d.day)}: ${d.visitors} visitors, ${d.views} views</title><rect class="vr-bar-views" x="${x}" y="${(h - vh).toFixed(1)}" width="${bwi}" height="${vh.toFixed(1)}"/><rect class="vr-bar-visitors" x="${x}" y="${(h - uh).toFixed(1)}" width="${bwi}" height="${uh.toFixed(1)}"/></g>`;
    })
    .join('');
  return `<figure class="vr-chart"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Daily visitors">${bars}</svg>
    <figcaption><span>${esc(daily[0].day)}</span><span><i class="vr-key vr-key-visitors"></i>visitors <i class="vr-key vr-key-views"></i>page views · peak ${n(max)}/day</span><span>${esc(daily[daily.length - 1].day)}</span></figcaption></figure>`;
}

function list(title, items, { label = (k) => k, metric = 'visitors' } = {}) {
  const top = items.slice(0, TOP);
  const max = Math.max(1, ...top.map((x) => x[metric]));
  const body = top.length
    ? top
        .map(
          (x) => `<li><span class="vr-fill" style="width:${((x[metric] / max) * 100).toFixed(1)}%"></span><span class="vr-name">${esc(label(x.key))}</span><span class="vr-num">${n(x[metric])}</span></li>`,
        )
        .join('')
    : '<li class="vr-empty">No data yet</li>';
  return `<section class="vr-list"><h4>${esc(title)}<small>${metric === 'views' ? 'views' : 'visitors'}</small></h4><ol>${body}</ol></section>`;
}

export function reportHtml(agg, { titleOf = () => null } = {}) {
  const page = (p) => pageLabel(p, titleOf);
  const recent = agg.recent.length
    ? `<div class="vr-table-wrap"><table class="vr-table"><thead><tr><th>When</th><th>Visitor</th><th>Page</th><th>From</th><th>Device</th><th>Came from</th></tr></thead><tbody>${agg.recent
        .map(
          (r) => `<tr><td class="vr-mono">${esc(fmtTime(r.ts))}</td><td class="vr-mono">${esc(r.vid.slice(0, 6))}${r.new_visitor ? ' <span class="vr-pill">new</span>' : ''}${
            r.guest ? ` <span class="vr-pill vr-guest">${esc(r.guest)}</span>` : ''
          }</td><td>${esc(page(r.path))}</td><td>${esc([r.city, r.region, r.country].filter(Boolean).join(', ') || '—')}</td><td>${esc(
            [r.device, r.browser, r.os].filter(Boolean).join(' · '),
          )}</td><td>${esc(r.referrer || 'direct')}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : '<p class="vr-empty">No visits in this period yet.</p>';
  return `<div class="vr">
  <div class="vr-cards">${card('Today', agg.today)}${card(agg.from ? `Since ${new Date(agg.from).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : 'Selected period', agg.range)}${card(
    agg.allTime?.first ? `All time (since ${new Date(agg.allTime.first).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })})` : 'All time',
    agg.allTime,
  )}</div>
  <h3 class="vr-h">Visitors per day</h3>
  ${chart(agg.daily)}
  <div class="vr-grid">
    ${list('Top pages', agg.pages, { label: page, metric: 'views' })}
    ${list('Countries', agg.countries)}
    ${list('Cities', agg.cities)}
    ${list('Came from', agg.referrers)}
    ${list('Guests (access codes)', agg.guests, { metric: 'views' })}
    ${list('Devices', agg.devices)}
    ${list('Browsers', agg.browsers)}
    ${list('Operating systems', agg.os)}
  </div>
  <h3 class="vr-h">Recent visits <small>latest ${agg.recent.length}</small></h3>
  ${recent}
  <p class="vr-foot">Visitors are counted by an anonymous ID stored in each browser. IP addresses are never stored. Your own author devices are not counted.</p>
</div>`;
}

export const REPORT_CSS = `
.vr { --vr-ink: var(--ink, #1e1914); --vr-mute: var(--ink-3, #7d7264); --vr-rule: var(--rule, #cbbfa8); --vr-card: var(--card, #fbf8f1);
  --vr-accent: var(--accent, #8c2f1b); --vr-learn: var(--learn, #2f5d50); color: var(--vr-ink); }
.vr-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
.vr-card { background: var(--vr-card); border: 1px solid var(--vr-rule); padding: .9rem 1.1rem; }
.vr-card-label, .vr-h small, .vr-list h4 small { font-family: var(--mono, ui-monospace, Consolas, monospace); font-size: .66rem; text-transform: uppercase; letter-spacing: .12em; color: var(--vr-mute); }
.vr-card b { font-family: var(--display, Georgia, serif); font-size: 2.4rem; line-height: 1.1; margin-right: .35rem; }
.vr-card-sub { font-size: .85rem; color: var(--vr-mute); }
.vr-h { font-family: var(--display, Georgia, serif); margin: 1.6rem 0 .6rem; font-size: 1.25rem; }
.vr-h small { margin-left: .5rem; }
.vr-chart { margin: 0 0 1.5rem; background: var(--vr-card); border: 1px solid var(--vr-rule); padding: .8rem; }
.vr-chart svg { width: 100%; height: 160px; display: block; }
.vr-bar-views { fill: color-mix(in srgb, var(--vr-accent) 28%, transparent); }
.vr-bar-visitors { fill: var(--vr-accent); }
.vr-chart figcaption { display: flex; justify-content: space-between; gap: 1rem; font-family: var(--mono, ui-monospace, Consolas, monospace); font-size: .7rem; color: var(--vr-mute); margin-top: .4rem; }
.vr-key { display: inline-block; width: .7rem; height: .7rem; margin: 0 .25rem 0 .6rem; vertical-align: -1px; }
.vr-key-visitors { background: var(--vr-accent); } .vr-key-views { background: color-mix(in srgb, var(--vr-accent) 28%, transparent); }
.vr-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem 1.5rem; }
.vr-list h4 { display: flex; justify-content: space-between; align-items: baseline; margin: 0 0 .3rem; border-bottom: 1.5px solid var(--vr-ink); padding-bottom: .2rem; font-family: var(--display, Georgia, serif); font-size: 1rem; }
.vr-list ol { list-style: none; margin: 0; padding: 0; }
.vr-list li { position: relative; display: flex; justify-content: space-between; gap: .6rem; padding: .28rem .4rem; border-bottom: 1px solid var(--vr-rule); font-size: .92rem; }
.vr-fill { position: absolute; inset: 0 auto 0 0; background: color-mix(in srgb, var(--vr-learn) 13%, transparent); z-index: 0; }
.vr-name, .vr-num { position: relative; z-index: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vr-num { font-family: var(--mono, ui-monospace, Consolas, monospace); font-size: .8rem; flex: none; }
.vr-table-wrap { overflow-x: auto; }
.vr-table { width: 100%; border-collapse: collapse; font-size: .88rem; }
.vr-table th { text-align: left; font-family: var(--mono, ui-monospace, Consolas, monospace); font-size: .64rem; text-transform: uppercase; letter-spacing: .1em; color: var(--vr-mute); border-bottom: 1.5px solid var(--vr-ink); padding: .35rem .5rem; }
.vr-table td { border-bottom: 1px solid var(--vr-rule); padding: .4rem .5rem; vertical-align: top; }
.vr-mono { font-family: var(--mono, ui-monospace, Consolas, monospace); font-size: .78rem; white-space: nowrap; }
.vr-pill { font-family: var(--mono, ui-monospace, Consolas, monospace); font-size: .6rem; text-transform: uppercase; border: 1px solid var(--vr-learn); color: var(--vr-learn); padding: 0 .3rem; border-radius: 99px; }
.vr-guest { border-color: var(--vr-accent); color: var(--vr-accent); text-transform: none; }
.vr-empty { color: var(--vr-mute); font-style: italic; }
.vr-foot { color: var(--vr-mute); font-size: .8rem; margin-top: 1.2rem; }
`;

export function standaloneReport(agg, { titleOf, siteTitle = 'Little by Little', rangeLabel = '' } = {}) {
  const generated = new Date(agg.now).toLocaleString();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Visitor report: ${esc(siteTitle)}</title>
<style>
body { margin: 0; background: #f3eee3; color: #1e1914; font: 16px/1.5 'Iowan Old Style', 'Palatino Linotype', Georgia, serif; }
main { max-width: 1100px; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
header { border-bottom: 3px double #1e1914; margin-bottom: 1.5rem; padding-bottom: .8rem; }
header h1 { margin: 0; font-size: 2.2rem; } header p { margin: .2rem 0 0; color: #7d7264; font-family: Consolas, monospace; font-size: .8rem; }
${REPORT_CSS}
</style></head>
<body><main>
<header><h1>Visitor report</h1><p>${esc(siteTitle)} · ${esc(rangeLabel)} · generated ${esc(generated)} · PRIVATE</p></header>
${reportHtml(agg, { titleOf })}
</main></body></html>`;
}
