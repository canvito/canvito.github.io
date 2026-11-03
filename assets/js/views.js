import { renderMarkdown, safeUrl } from './markdown.js';
import { KINDS, KIND_ALIASES } from './vault.js';
import { S, getPost, assetUrl, isOwner, visibleTiers, setPinned } from './session.js';
import { esc, $, $$, fmtDate, parseDate, weekday, monthName, modal, sealHtml, confirmDialog, toast } from './util.js';
import { t, loc, lang } from './i18n.js';

const kindStamp = (k) => `<span class="stamp k-${esc(k)}">${esc(t(KINDS[k]?.stamp || k))}</span>`;
const kindLabel = (k) => t(KINDS[k]?.label || k);
const tagLinks = (tags) => (tags?.length ? `<div class="tags">${tags.map((t) => `<a href="#/journal?tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}</div>` : '');
const entries = () => S.metas.filter((m) => m.kind !== 'page');
const href = (m) => `#/p/${encodeURIComponent(m.id)}`;

// ---------- search ----------
// Matches English and Vietnamese text; accents are ignored, so "hoc" finds "học".
const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');

export function search(metas, { q = '', kind, tag, year, tier } = {}) {
  const terms = [];
  for (const tok of fold(q).match(/(\w+:"[^"]+"|\w+:\S+|"[^"]+"|\S+)/g) || []) {
    const m = tok.match(/^(tag|kind|year|tier|date):"?([^"]+)"?$/);
    if (m) {
      if (m[1] === 'tag') tag = m[2];
      else if (m[1] === 'kind') kind = KIND_ALIASES[m[2]] || m[2];
      else if (m[1] === 'year' || m[1] === 'date') year = m[2];
      else tier = m[2];
    } else terms.push(tok.replace(/"/g, ''));
  }
  const out = [];
  for (const m of metas) {
    if (kind && m.kind !== kind) continue;
    if (tier && m.tier !== tier) continue;
    if (tag && !m.tags?.includes(tag)) continue;
    if (year && !m.date.startsWith(year)) continue;
    let score = 0;
    let ok = true;
    const title = fold(`${m.title} ${m.vi?.title || ''}`);
    const tags = fold((m.tags || []).join(' '));
    const summary = fold(`${m.summary || ''} ${m.vi?.summary || ''}`);
    const body = fold(`${m.excerpt || ''} ${m.vi?.excerpt || ''}`);
    const locn = fold(m.location);
    for (const t of terms) {
      const s = (title.includes(t) ? 6 : 0) + (tags.includes(t) ? 4 : 0) + (summary.includes(t) ? 2 : 0) + (locn.includes(t) ? 2 : 0) + (body.includes(t) ? 1 : 0);
      if (!s) {
        ok = false;
        break;
      }
      score += s;
    }
    if (ok) out.push({ m, score });
  }
  if (terms.length) out.sort((a, b) => b.score - a.score || b.m.date.localeCompare(a.m.date));
  return out.map((x) => x.m);
}

// ---------- covers & media hydration ----------
const io = 'IntersectionObserver' in window ? new IntersectionObserver((list) => list.forEach((e) => e.isIntersecting && (io.unobserve(e.target), fillCover(e.target))), { rootMargin: '300px' }) : null;

async function fillCover(el) {
  const m = S.byId.get(el.dataset.cover);
  if (!m) return;
  let url = null;
  try {
    if (m.coverAsset) url = await assetUrl(m.id, m.tier, m.coverAsset);
    else if (m.cover) url = safeUrl(m.cover);
  } catch {}
  if (url && !url.startsWith('media:')) el.innerHTML = `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  else if (!el.closest('.lead-cover')) el.remove();
}

export function hydrateCovers(root) {
  for (const el of $$('[data-cover]', root)) {
    const m = S.byId.get(el.dataset.cover);
    if (!m || (!m.coverAsset && !m.cover)) {
      el.remove();
      continue;
    }
    io ? io.observe(el) : fillCover(el);
  }
}

export async function hydrateMedia(root, post, pending = new Map()) {
  for (const el of $$('[data-asset]', root)) {
    const id = el.dataset.asset;
    const asset = post.assets?.find((a) => a.id === id);
    let url = pending.get(id) || null;
    try {
      if (!url && asset) url = await assetUrl(post.id, post.tier, asset);
    } catch (e) {
      console.warn(e);
    }
    if (!url) {
      el.outerHTML = `<div class="locked-media">${sealHtml(post.tier === 'public' ? 'protected' : post.tier)} Attachment unavailable</div>`;
      continue;
    }
    if (el.tagName === 'A') {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const a = document.createElement('a');
        a.href = url;
        a.download = el.dataset.download || 'file';
        a.target = '_blank';
        a.rel = 'noopener';
        a.click();
      });
    } else el.src = url;
  }
}

export function enableLightbox(root) {
  root.addEventListener('click', (e) => {
    const img = e.target.closest('figure img');
    if (!img || !img.src) return;
    modal(`<img src="${esc(img.src)}" alt="${esc(img.alt)}">`, { wide: true });
  });
}

// ---------- front page ----------
function inkmap(year) {
  const counts = new Map();
  for (const m of entries()) {
    const p = parseDate(m.date);
    if (p.y !== year || !p.d) continue;
    const key = m.date.slice(0, 10);
    const c = counts.get(key) || { n: 0, kinds: {} };
    c.n++;
    c.kinds[m.kind] = (c.kinds[m.kind] || 0) + 1;
    counts.set(key, c);
  }
  const start = new Date(year, 0, 1);
  const cells = [];
  for (let i = 0; i < start.getDay(); i++) cells.push('<i class="blank"></i>');
  for (let d = new Date(start); d.getFullYear() === year; d.setDate(d.getDate() + 1)) {
    const key = `${year}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const c = counts.get(key);
    if (!c) cells.push(`<i title="${key}"></i>`);
    else {
      const kind = Object.entries(c.kinds).sort((a, b) => b[1] - a[1])[0][0];
      cells.push(`<i class="on" data-day="${key}" style="--k:var(--${kind});--o:${Math.min(1, 0.55 + c.n * 0.15)}" title="${esc(t(c.n > 1 ? '{date} · {n} entries' : '{date} · {n} entry', { date: key, n: c.n }))}"></i>`);
    }
  }
  return `<div class="inkmap-wrap"><div class="inkmap">${cells.join('')}</div></div>`;
}

function onThisDay() {
  const now = new Date();
  const md = `-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const list = entries().filter((m) => m.date.slice(4, 10) === md && +m.date.slice(0, 4) < now.getFullYear());
  if (!list.length) return '';
  const today = lang === 'vi' ? `Ngày ${now.getDate()} tháng ${now.getMonth() + 1}` : `${monthName(now.getMonth() + 1)} ${now.getDate()}`;
  return `<div class="on-this-day"><div class="kicker">${esc(t('On this day'))}</div><h3>${esc(t('{date}, across the years', { date: today }))}</h3><ul>${list
    .map((m) => `<li><span class="yrs">${esc(t('{n}y ago', { n: now.getFullYear() - +m.date.slice(0, 4) }))}</span><a href="${href(m)}">${esc(loc(m, 'title'))}</a> ${sealHtml(m.tier)}</li>`)
    .join('')}</ul></div>`;
}

function card(m) {
  const summary = loc(m, 'summary');
  return `<a class="card" href="${href(m)}">
    <div class="cover" data-cover="${esc(m.id)}"></div>
    <div class="card-meta">${kindStamp(m.kind)}<span class="date">${esc(fmtDate(m.date, { short: true }))}</span>${sealHtml(m.tier)}</div>
    <h3>${esc(loc(m, 'title'))}</h3>
    ${summary ? `<p>${esc(summary)}</p>` : ''}
  </a>`;
}

export function homeView(root) {
  const all = entries();
  const count = (k) => all.filter((m) => m.kind === k).length;
  const years = [...new Set(all.map((m) => +m.date.slice(0, 4)))].sort((a, b) => b - a);
  const learn = count('learn');
  const give = count('give');
  const total = learn + give || 1;
  const lead = all.find((m) => m.coverAsset || m.cover) || all[0];
  const rest = all.filter((m) => m !== lead).slice(0, 6);
  const span = years.length ? `${years[years.length - 1]}–${years[0]}` : '—';
  const stats = threadStats();
  const pins = pinnedVisible(stats);
  const topTags = [...pins.map((tg) => [tg, stats.get(tg).length, true]), ...[...stats].filter(([tg]) => !pins.includes(tg)).map(([tg, l]) => [tg, l.length, false]).sort((a, b) => b[1] - a[1])].slice(0, 18);

  root.innerHTML = `
  <section class="hero">
    <article class="lead-story">
      ${
        lead
          ? `<div class="lead-cover" data-cover="${esc(lead.id)}"></div>
      <div class="card-meta">${kindStamp(lead.kind)}<span class="date">${esc(fmtDate(lead.date))}</span>${sealHtml(lead.tier, true)}</div>
      <h1><a href="${href(lead)}">${esc(loc(lead, 'title'))}</a></h1>
      ${loc(lead, 'summary') ? `<p class="dek">${esc(loc(lead, 'summary'))}</p>` : ''}
      <a class="btn ghost" href="${href(lead)}">${esc(t('Read the entry →'))}</a>`
          : `<div class="kicker">${esc(t('Volume I'))}</div><h1>${esc(t('The first page is still blank.'))}</h1><p class="dek">${esc(t('Every journey of learning begins with a single entry.'))}</p>`
      }
    </article>
    <aside>
      <div class="ledger">
        <div><b>${learn}</b><span>${esc(t('Learned'))}</span></div>
        <div><b>${give}</b><span>${esc(t('Gave'))}</span></div>
        <div><b>${count('reflect')}</b><span>${esc(t('Reflections'))}</span></div>
        <div><b>${count('milestone')}</b><span>${esc(t('Milestones'))}</span></div>
      </div>
      <div class="balance">
        <div class="balance-bar" title="${esc(t('Learn / Give balance'))}"><i class="b-learn" style="width:${(learn / total) * 100}%"></i><i class="b-give" style="width:${(give / total) * 100}%"></i></div>
        <div class="balance-legend"><span>${esc(t('Learn {p}%', { p: Math.round((learn / total) * 100) }))}</span><span>${esc(span)}</span><span>${esc(t('Give {p}%', { p: Math.round((give / total) * 100) }))}</span></div>
      </div>
      ${stats.size ? '<div class="spotlight" id="spotlight" aria-live="polite"></div>' : ''}
    </aside>
  </section>

  ${onThisDay() ? `<div style="margin-top:2rem">${onThisDay()}</div>` : ''}

  ${
    years.length
      ? `<div class="section-head"><h2>${esc(t('The Year in Ink'))}</h2><a class="more" href="#/journal">${esc(t('Full journal →'))}</a></div>
  <div class="inkmap-head"><div class="year-tabs" role="tablist">${years.map((y, i) => `<button type="button" data-year="${y}" aria-pressed="${i === 0}">${y}</button>`).join('')}</div></div>
  <div id="inkmap">${inkmap(years[0])}</div>
  <div class="legend">${Object.keys(KINDS).filter((k) => k !== 'page').map((k) => `<span><i style="--k:var(--${k})"></i>${esc(kindLabel(k))}</span>`).join('')}</div>`
      : ''
  }

  ${rest.length ? `<div class="section-head"><h2>${esc(t('Latest Entries'))}</h2><a class="more" href="#/journal">${esc(t('All {n} →', { n: all.length }))}</a></div><div class="columns">${rest.map(card).join('')}</div>` : ''}

  ${
    topTags.length
      ? `<div class="section-head"><h2>${esc(t('Threads'))}</h2><a class="more" href="#/threads">${esc(t('All threads →'))}</a></div>
  <div class="filters">${topTags.map(([tg, n, pinned]) => `<a class="chip${pinned ? ' pinned' : ''}" href="#/journal?tag=${encodeURIComponent(tg)}">${pinned ? '📌 ' : ''}#${esc(tg)} <span class="muted">${n}</span></a>`).join('')}</div>`
      : ''
  }`;

  hydrateCovers(root);
  startSpotlight(root, stats, pins);
  root.querySelector('.year-tabs')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-year]');
    if (!b) return;
    $$('.year-tabs button', root).forEach((x) => x.setAttribute('aria-pressed', x === b));
    $('#inkmap', root).innerHTML = inkmap(+b.dataset.year);
  });
  root.addEventListener('click', (e) => {
    const d = e.target.closest('[data-day]');
    if (d) location.hash = `#/journal?q=${encodeURIComponent(`date:${d.dataset.day}`)}`;
  });
}

// ---------- threads (tags) ----------
// tag -> visible entries, newest first.
function threadStats() {
  const m = new Map();
  for (const e of entries()) for (const tg of e.tags || []) (m.get(tg) || m.set(tg, []).get(tg)).push(e);
  return m;
}
// Pinned threads that this visitor can actually see entries in, in pin order.
const pinnedVisible = (stats) => S.pinned.filter((tg) => stats.has(tg));
const tagHref = (tg) => `#/journal?tag=${encodeURIComponent(tg)}`;

// Front-page card that shows a random thread every spotlightSeconds (config, default 16).
// Pinned threads come up twice as often. Pauses on hover/focus; still for reduced-motion users.
function startSpotlight(root, stats, pins) {
  const el = $('#spotlight', root);
  if (!el) return;
  const pinned = new Set(pins);
  const pool = [...stats.keys()].flatMap((tg) => (pinned.has(tg) ? [tg, tg] : [tg]));
  let current = null;
  const show = () => {
    let tg;
    do tg = pool[Math.floor(Math.random() * pool.length)];
    while (stats.size > 1 && tg === current);
    current = tg;
    const list = stats.get(tg);
    const picks = [...list].sort(() => Math.random() - 0.5).slice(0, 3);
    el.classList.remove('in');
    el.innerHTML = `<div class="kicker">${pinned.has(tg) ? '📌 ' : ''}${esc(t('Thread spotlight'))}</div>
      <h3><a href="${tagHref(tg)}">#${esc(tg)}</a></h3>
      <div class="mono muted small">${esc(t(list.length === 1 ? '{n} entry' : '{n} entries', { n: list.length }))}</div>
      <ul>${picks.map((m) => `<li><a href="${href(m)}">${esc(loc(m, 'title'))}</a><span class="mono muted small">${esc(fmtDate(m.date, { short: true }))}</span></li>`).join('')}</ul>
      <a class="more mono small" href="${tagHref(tg)}">${esc(t('See all →'))}</a>`;
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  };
  show();
  if (stats.size < 2 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let paused = false;
  el.addEventListener('mouseenter', () => (paused = true));
  el.addEventListener('mouseleave', () => (paused = false));
  el.addEventListener('focusin', () => (paused = true));
  el.addEventListener('focusout', () => (paused = false));
  const timer = setInterval(() => {
    if (!el.isConnected) return clearInterval(timer);
    if (!paused && document.visibilityState === 'visible') show();
  }, (Number(S.cfg.spotlightSeconds) || 16) * 1000);
}

// ---------- journal ----------
export function journalView(root, params) {
  const f = Object.fromEntries(params);
  const results = search(entries(), f);
  const filtered = Object.values(f).some(Boolean);
  const years = {};
  for (const m of results) (years[m.date.slice(0, 4)] ||= []).push(m);
  const yearKeys = Object.keys(years).sort((a, b) => b - a);
  const qp = (patch) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v ? p.set(k, v) : p.delete(k);
    const s = p.toString();
    return `#/journal${s ? `?${s}` : ''}`;
  };
  const tiers = visibleTiers();

  let body = '';
  for (const y of yearKeys) {
    body += `<section class="year-block" id="y-${y}"><div class="year-label">${y}</div>`;
    let lastMonth = null;
    for (const m of years[y]) {
      const p = parseDate(m.date);
      const monthKey = p.m || 0;
      if (monthKey !== lastMonth) {
        body += `<div class="month-label">${esc(p.m ? monthName(p.m) : t('Sometime this year'))}</div>`;
        lastMonth = monthKey;
      }
      const summary = loc(m, 'summary');
      body += `<a class="entry k-${esc(m.kind)}" href="${href(m)}">
        <div class="day">${p.d ? `<b>${p.d}</b><span>${weekday(m.date)}</span>` : `<b>·</b>`}</div>
        <div class="body">
          <div class="card-meta">${kindStamp(m.kind)}${sealHtml(m.tier)}${m.location ? `<span class="date">${esc(m.location)}</span>` : ''}</div>
          <h3>${esc(loc(m, 'title'))}</h3>
          ${summary ? `<p>${esc(summary)}</p>` : ''}
          ${m.tags?.length ? `<div class="tags">${m.tags.map((t) => `<span>#${esc(t)}</span>`).join('')}</div>` : ''}
        </div>
        <div class="thumb" data-cover="${esc(m.id)}"></div>
      </a>`;
    }
    body += '</section>';
  }

  root.innerHTML = `
  <div class="journal">
    <nav class="year-rail" aria-label="${esc(t('Years'))}">${yearKeys.map((y) => `<a href="#y-${y}" data-jump="${y}">${y}<small>${years[y].length}</small></a>`).join('')}</nav>
    <div>
      <div class="filters">
        <a class="chip ${!f.kind ? 'on' : ''}" href="${qp({ kind: '' })}">${esc(t('All'))}</a>
        ${Object.keys(KINDS).filter((k) => k !== 'page').map((k) => `<a class="chip ${f.kind === k ? 'on' : ''}" href="${qp({ kind: f.kind === k ? '' : k })}">${esc(kindLabel(k))}</a>`).join('')}
        ${tiers.length > 1 ? `<span class="sep"></span>${tiers.map((tr) => `<a class="chip ${f.tier === tr ? 'on' : ''}" href="${qp({ tier: f.tier === tr ? '' : tr })}">${esc(t(tr))}</a>`).join('')}` : ''}
        ${f.tag ? `<span class="sep"></span><a class="chip on" href="${qp({ tag: '' })}">#${esc(f.tag)} ✕</a>` : ''}
      </div>
      ${filtered ? `<p class="result-note">${esc(t(results.length === 1 ? '{n} entry' : '{n} entries', { n: results.length }))}${f.q ? esc(t(' for “{q}”', { q: f.q })) : ''}. <a href="#/journal">${esc(t('Clear'))}</a></p>` : ''}
      ${body || `<div class="empty">${esc(t(filtered ? 'Nothing matches — try fewer words.' : 'No entries yet.'))}</div>`}
    </div>
  </div>`;
  hydrateCovers(root);
  root.querySelector('.year-rail')?.addEventListener('click', (e) => {
    const a = e.target.closest('[data-jump]');
    if (!a) return;
    e.preventDefault();
    document.getElementById(`y-${a.dataset.jump}`)?.scrollIntoView({ behavior: 'smooth' });
  });
}

// ---------- article ----------
export async function postView(root, id, { asPage = false } = {}) {
  const meta = S.byId.get(id);
  if (!meta) return notFound(root, S.mode === 'public' ? t('This entry may be sealed. If you have an access code, unlock the journal above.') : undefined);
  root.innerHTML = `<div class="loading"><span class="quill"></span>${esc(t('Unsealing…'))}</div>`;
  let post;
  try {
    post = await getPost(id);
  } catch (e) {
    return notFound(root, e.message);
  }
  if (!post) return notFound(root);
  const ctx = { asset: (aid) => post.assets?.find((a) => a.id === aid) };
  const list = entries();
  const i = list.findIndex((m) => m.id === id);
  const newer = i > 0 ? list[i - 1] : null;
  const older = i >= 0 && i < list.length - 1 ? list[i + 1] : null;
  const coverHtml = post.cover
    ? post.cover.startsWith('media:')
      ? `<figure class="article-cover"><img data-asset="${esc(post.cover.slice(6))}" alt=""></figure>`
      : safeUrl(post.cover)
        ? `<figure class="article-cover"><img src="${esc(safeUrl(post.cover))}" alt="" referrerpolicy="no-referrer"></figure>`
        : ''
    : '';
  const title = loc(post, 'title');
  const summary = loc(post, 'summary');
  const showVi = lang === 'vi' && !!post.vi?.body?.trim();
  const bodyMd = showVi ? post.vi.body : post.body;
  const fallbackNote = lang === 'vi' && !asPage && !showVi && post.body.trim() ? `<p class="mono muted small lang-note">${esc(t('No Vietnamese version yet — showing the English original.'))}</p>` : '';
  const words = showVi ? bodyMd.split(/\s+/).filter(Boolean).length : meta.words || 0;
  document.title = `${title} — ${(lang === 'vi' && S.cfg.i18n?.vi?.title) || S.cfg.title || 'Little × Little'}`;
  root.innerHTML = `
  <article class="article">
    <header class="article-head">
      <div class="card-meta" style="justify-content:center">${asPage ? '' : kindStamp(post.kind)}${sealHtml(post.tier, true)}</div>
      <h1>${esc(title)}</h1>
      ${summary ? `<p class="dek">${esc(summary)}</p>` : ''}
      ${
        asPage
          ? ''
          : `<div class="byline"><span>${esc(fmtDate(post.date))}</span>${post.location ? `<span>· ${esc(post.location)}</span>` : ''}<span>· ${esc(t('{n} min read', { n: Math.max(1, Math.round(words / 230)) }))}</span>${
              isOwner() ? `<a href="#/studio/edit/${encodeURIComponent(post.id)}">· ${esc(t('Edit'))}</a>` : ''
            }</div>`
      }
    </header>
    ${fallbackNote}
    ${coverHtml}
    <div class="prose"${showVi ? ' lang="vi"' : lang === 'vi' ? ' lang="en"' : ''}>${renderMarkdown(bodyMd, ctx)}</div>
    ${
      asPage
        ? isOwner()
          ? `<p class="mono"><a href="#/studio/edit/${encodeURIComponent(post.id)}">${esc(t('Edit this page'))}</a></p>`
          : ''
        : `<footer class="article-foot">
      ${tagLinks(post.tags)}
      <div class="pager">
        ${newer ? `<a href="${href(newer)}"><small>${esc(t('← Newer'))}</small>${esc(loc(newer, 'title'))}</a>` : '<span></span>'}
        ${older ? `<a href="${href(older)}"><small>${esc(t('Older →'))}</small>${esc(loc(older, 'title'))}</a>` : '<span></span>'}
      </div>
    </footer>`
    }
  </article>`;
  hydrateMedia(root, post);
  enableLightbox(root);
}

// ---------- threads ----------
export function threadsView(root) {
  const stats = threadStats();
  const tags = [...stats].map(([tg, l]) => [tg, l.length]).sort((a, b) => a[0].localeCompare(b[0]));
  const max = Math.max(1, ...tags.map((x) => x[1]));
  const pins = pinnedVisible(stats);
  const kinds = Object.keys(KINDS).filter((k) => k !== 'page');
  root.innerHTML = `
  <div class="section-head"><h2>${esc(t('Threads'))}</h2><span class="mono muted">${esc(t(tags.length === 1 ? '{n} thread' : '{n} threads', { n: tags.length }))}</span></div>
  ${
    pins.length
      ? `<div class="pinned-threads"><span class="kicker">📌 ${esc(t('Pinned'))}</span>${pins.map((tg) => `<a class="chip pinned" href="${tagHref(tg)}">#${esc(tg)} <span class="muted">${stats.get(tg).length}</span></a>`).join('')}</div>`
      : ''
  }
  ${
    tags.length
      ? `<div class="cloud">${tags
          .map(([tg, n]) => `<a class="${pins.includes(tg) ? 'pinned' : ''}" href="${tagHref(tg)}" style="font-size:${(1 + (n / max) * 1.8).toFixed(2)}rem;font-weight:${400 + Math.round((n / max) * 400)}">${esc(tg)}<small>${n}</small></a>`)
          .join('')}</div>`
      : `<div class="empty">${esc(t('No threads yet — add tags to entries.'))}</div>`
  }
  ${
    isOwner() && tags.length
      ? `<div class="pin-admin"><h3>Pin threads <small class="mono muted">(only you see this; pinned names are public)</small></h3>
      <div class="filters">${tags.map(([tg]) => `<button type="button" class="chip ${S.pinned.includes(tg) ? 'on' : ''}" data-pin="${esc(tg)}" aria-pressed="${S.pinned.includes(tg)}">${S.pinned.includes(tg) ? '📌 ' : ''}#${esc(tg)}</button>`).join('')}</div></div>`
      : ''
  }
  <div class="section-head"><h2>${esc(t('By Kind'))}</h2></div>
  <div class="columns">${kinds
    .map((k) => {
      const n = entries().filter((m) => m.kind === k).length;
      const label = lang === 'vi' ? kindLabel(k).toLowerCase() : `${KINDS[k].label.toLowerCase()}${n === 1 ? '' : k === 'reflect' || k === 'milestone' || k === 'artifact' ? 's' : ''}`;
      return `<a class="card" href="#/journal?kind=${k}"><div class="card-meta">${kindStamp(k)}</div><h3>${n} ${esc(label)}</h3></a>`;
    })
    .join('')}</div>`;

  root.querySelector('.pin-admin')?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pin]');
    if (!b) return;
    const tg = b.dataset.pin;
    const pinning = !S.pinned.includes(tg);
    // A tag used only by sealed entries would reveal its name in the public repo.
    if (pinning && !stats.get(tg).some((m) => m.tier === 'public') && !(await confirmDialog(`#${tg} has no public entries. Pinning publishes the name "${tg}" in the public repo (visitors still only see it if they can read entries in it). Pin anyway?`, 'Pin'))) return;
    b.disabled = true;
    try {
      await setPinned(pinning ? [...S.pinned, tg] : S.pinned.filter((x) => x !== tg));
      toast(pinning ? `Pinned #${tg}. The live site updates in about a minute.` : `Unpinned #${tg}.`);
      threadsView(root);
    } catch (ex) {
      toast(ex.message, 6000);
      b.disabled = false;
    }
  });
}

// ---------- about ----------
const visitNote = () => `<p class="mono muted small privacy-note">${esc(t('This site counts visits anonymously.'))}</p>`;

export async function aboutView(root) {
  if (S.byId.has('about')) {
    await postView(root, 'about', { asPage: true });
    root.querySelector('.article')?.insertAdjacentHTML('beforeend', visitNote());
    return;
  }
  root.innerHTML = `
  <article class="article">
    <header class="article-head"><div class="kicker">${esc(t('Colophon'))}</div><h1>${esc(t('About this journal'))}</h1>
    <p class="dek">${esc(t('A single home for a lifetime of learning and giving.'))}</p></header>
    <div class="prose">
      <p>${esc(t('This is the source of truth for my journey: the things I have learned, the things I have given, and the artifacts collected along the way. My motto: Learn, Give, Love, Laugh.'))}</p>
      <p>${t('Some pages are open to everyone. Some are <strong>protected</strong> and readable by people I give an access code to. Some are <strong>private</strong> and kept only for me. Sealed pages stay encrypted until the right key opens them, both here and in the repository behind the site.')}</p>
      <p>${t('If you have an access code, use the <em>Unlock</em> button at the top of the page. If you\'d like to say hello, please sign the <a href="#/guestbook">guestbook</a>.')}</p>
    </div>
    ${visitNote()}
    ${isOwner() ? '<p class="mono">Tip: create an entry with id <code>about</code> (kind “page”) to replace this text. Add a Vietnamese version to translate it.</p>' : ''}
  </article>`;
}

export function notFound(root, msg) {
  root.innerHTML = `<div class="empty"><h2 style="font-style:normal">${esc(t('This page is missing or sealed.'))}</h2><p>${esc(msg || t('It may have moved, or it may be locked.'))}</p><p><a class="btn ghost" href="#/journal">${esc(t('Back to the journal'))}</a></p></div>`;
}
