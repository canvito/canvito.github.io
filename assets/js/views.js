import { renderMarkdown, safeUrl } from './markdown.js';
import { KINDS } from './vault.js';
import { S, getPost, assetUrl, isOwner, visibleTiers } from './session.js';
import { esc, $, $$, fmtDate, parseDate, weekday, monthName, modal, sealHtml } from './util.js';

const kindStamp = (k) => `<span class="stamp k-${esc(k)}">${esc(KINDS[k]?.stamp || k)}</span>`;
const tagLinks = (tags) => (tags?.length ? `<div class="tags">${tags.map((t) => `<a href="#/journal?tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}</div>` : '');
const entries = () => S.metas.filter((m) => m.kind !== 'page');
const href = (m) => `#/p/${encodeURIComponent(m.id)}`;

// ---------- search ----------
export function search(metas, { q = '', kind, tag, year, tier } = {}) {
  const terms = [];
  for (const tok of String(q).toLowerCase().match(/(\w+:"[^"]+"|\w+:\S+|"[^"]+"|\S+)/g) || []) {
    const m = tok.match(/^(tag|kind|year|tier|date):"?([^"]+)"?$/);
    if (m) {
      if (m[1] === 'tag') tag = m[2];
      else if (m[1] === 'kind') kind = m[2];
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
    const title = m.title.toLowerCase();
    const tags = (m.tags || []).join(' ');
    const summary = (m.summary || '').toLowerCase();
    const body = (m.excerpt || '').toLowerCase();
    const loc = (m.location || '').toLowerCase();
    for (const t of terms) {
      const s = (title.includes(t) ? 6 : 0) + (tags.includes(t) ? 4 : 0) + (summary.includes(t) ? 2 : 0) + (loc.includes(t) ? 2 : 0) + (body.includes(t) ? 1 : 0);
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
      cells.push(`<i class="on" data-day="${key}" style="--k:var(--${kind});--o:${Math.min(1, 0.55 + c.n * 0.15)}" title="${key} · ${c.n} entr${c.n > 1 ? 'ies' : 'y'}"></i>`);
    }
  }
  return `<div class="inkmap-wrap"><div class="inkmap">${cells.join('')}</div></div>`;
}

function onThisDay() {
  const now = new Date();
  const md = `-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const list = entries().filter((m) => m.date.slice(4, 10) === md && +m.date.slice(0, 4) < now.getFullYear());
  if (!list.length) return '';
  return `<div class="on-this-day"><div class="kicker">On this day</div><h3>${monthName(now.getMonth() + 1)} ${now.getDate()}, across the years</h3><ul>${list
    .map((m) => `<li><span class="yrs">${now.getFullYear() - +m.date.slice(0, 4)}y ago</span><a href="${href(m)}">${esc(m.title)}</a> ${sealHtml(m.tier)}</li>`)
    .join('')}</ul></div>`;
}

function card(m) {
  return `<a class="card" href="${href(m)}">
    <div class="cover" data-cover="${esc(m.id)}"></div>
    <div class="card-meta">${kindStamp(m.kind)}<span class="date">${esc(fmtDate(m.date, { short: true }))}</span>${sealHtml(m.tier)}</div>
    <h3>${esc(m.title)}</h3>
    ${m.summary ? `<p>${esc(m.summary)}</p>` : ''}
  </a>`;
}

export function homeView(root) {
  const all = entries();
  const count = (k) => all.filter((m) => m.kind === k).length;
  const years = [...new Set(all.map((m) => +m.date.slice(0, 4)))].sort((a, b) => b - a);
  const learn = count('learn');
  const teach = count('teach');
  const total = learn + teach || 1;
  const lead = all.find((m) => m.coverAsset || m.cover) || all[0];
  const rest = all.filter((m) => m !== lead).slice(0, 6);
  const span = years.length ? `${years[years.length - 1]}–${years[0]}` : '—';
  const tagCounts = {};
  for (const m of all) for (const t of m.tags || []) tagCounts[t] = (tagCounts[t] || 0) + 1;
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 18);

  root.innerHTML = `
  <section class="hero">
    <article class="lead-story">
      ${
        lead
          ? `<div class="lead-cover" data-cover="${esc(lead.id)}"></div>
      <div class="card-meta">${kindStamp(lead.kind)}<span class="date">${esc(fmtDate(lead.date))}</span>${sealHtml(lead.tier, true)}</div>
      <h1><a href="${href(lead)}">${esc(lead.title)}</a></h1>
      ${lead.summary ? `<p class="dek">${esc(lead.summary)}</p>` : ''}
      <a class="btn ghost" href="${href(lead)}">Read the entry →</a>`
          : `<div class="kicker">Volume I</div><h1>The first page is still blank.</h1><p class="dek">Every journey of learning begins with a single entry.</p>`
      }
    </article>
    <aside>
      <div class="manifesto">
        <blockquote>“${esc(S.cfg.manifesto || 'The highest level of life is to learn and to teach. Everything else is either a reward or a byproduct.')}”</blockquote>
        <cite>— ${esc(S.cfg.author || 'Canvito')}</cite>
      </div>
      <div class="ledger">
        <div><b>${learn}</b><span>Learned</span></div>
        <div><b>${teach}</b><span>Taught</span></div>
        <div><b>${count('reflect')}</b><span>Reflections</span></div>
        <div><b>${count('milestone')}</b><span>Milestones</span></div>
      </div>
      <div class="balance">
        <div class="balance-bar" title="Learn / Teach balance"><i class="b-learn" style="width:${(learn / total) * 100}%"></i><i class="b-teach" style="width:${(teach / total) * 100}%"></i></div>
        <div class="balance-legend"><span>Learn ${Math.round((learn / total) * 100)}%</span><span>${esc(span)}</span><span>Teach ${Math.round((teach / total) * 100)}%</span></div>
      </div>
    </aside>
  </section>

  ${onThisDay() ? `<div style="margin-top:2rem">${onThisDay()}</div>` : ''}

  ${
    years.length
      ? `<div class="section-head"><h2>The Year in Ink</h2><a class="more" href="#/journal">Full journal →</a></div>
  <div class="inkmap-head"><div class="year-tabs" role="tablist">${years.map((y, i) => `<button type="button" data-year="${y}" aria-pressed="${i === 0}">${y}</button>`).join('')}</div></div>
  <div id="inkmap">${inkmap(years[0])}</div>
  <div class="legend">${Object.keys(KINDS).filter((k) => k !== 'page').map((k) => `<span><i style="--k:var(--${k})"></i>${KINDS[k].label}</span>`).join('')}</div>`
      : ''
  }

  ${rest.length ? `<div class="section-head"><h2>Latest Entries</h2><a class="more" href="#/journal">All ${all.length} →</a></div><div class="columns">${rest.map(card).join('')}</div>` : ''}

  ${
    topTags.length
      ? `<div class="section-head"><h2>Threads</h2><a class="more" href="#/threads">All threads →</a></div>
  <div class="filters">${topTags.map(([t, n]) => `<a class="chip" href="#/journal?tag=${encodeURIComponent(t)}">#${esc(t)} <span class="muted">${n}</span></a>`).join('')}</div>`
      : ''
  }`;

  hydrateCovers(root);
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
        body += `<div class="month-label">${p.m ? monthName(p.m) : 'Sometime this year'}</div>`;
        lastMonth = monthKey;
      }
      body += `<a class="entry k-${esc(m.kind)}" href="${href(m)}">
        <div class="day">${p.d ? `<b>${p.d}</b><span>${weekday(m.date)}</span>` : `<b>·</b>`}</div>
        <div class="body">
          <div class="card-meta">${kindStamp(m.kind)}${sealHtml(m.tier)}${m.location ? `<span class="date">${esc(m.location)}</span>` : ''}</div>
          <h3>${esc(m.title)}</h3>
          ${m.summary ? `<p>${esc(m.summary)}</p>` : ''}
          ${m.tags?.length ? `<div class="tags">${m.tags.map((t) => `<span>#${esc(t)}</span>`).join('')}</div>` : ''}
        </div>
        <div class="thumb" data-cover="${esc(m.id)}"></div>
      </a>`;
    }
    body += '</section>';
  }

  root.innerHTML = `
  <div class="journal">
    <nav class="year-rail" aria-label="Years">${yearKeys.map((y) => `<a href="#y-${y}" data-jump="${y}">${y}<small>${years[y].length}</small></a>`).join('')}</nav>
    <div>
      <div class="filters">
        <a class="chip ${!f.kind ? 'on' : ''}" href="${qp({ kind: '' })}">All</a>
        ${Object.keys(KINDS).filter((k) => k !== 'page').map((k) => `<a class="chip ${f.kind === k ? 'on' : ''}" href="${qp({ kind: f.kind === k ? '' : k })}">${KINDS[k].label}</a>`).join('')}
        ${tiers.length > 1 ? `<span class="sep"></span>${tiers.map((t) => `<a class="chip ${f.tier === t ? 'on' : ''}" href="${qp({ tier: f.tier === t ? '' : t })}">${t}</a>`).join('')}` : ''}
        ${f.tag ? `<span class="sep"></span><a class="chip on" href="${qp({ tag: '' })}">#${esc(f.tag)} ✕</a>` : ''}
      </div>
      ${filtered ? `<p class="result-note">${results.length} entr${results.length === 1 ? 'y' : 'ies'}${f.q ? ` for “${esc(f.q)}”` : ''}. <a href="#/journal">Clear</a></p>` : ''}
      ${body || `<div class="empty">${filtered ? 'Nothing matches — try fewer words.' : 'No entries yet.'}</div>`}
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
  if (!meta) return notFound(root, S.mode === 'public' ? 'This entry may be sealed. If you have an access code, unlock the journal above.' : undefined);
  root.innerHTML = '<div class="loading"><span class="quill"></span>Unsealing…</div>';
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
  document.title = `${post.title} — ${S.cfg.title || 'Canvito Life Journey'}`;
  root.innerHTML = `
  <article class="article">
    <header class="article-head">
      <div class="card-meta" style="justify-content:center">${asPage ? '' : kindStamp(post.kind)}${sealHtml(post.tier, true)}</div>
      <h1>${esc(post.title)}</h1>
      ${post.summary ? `<p class="dek">${esc(post.summary)}</p>` : ''}
      ${
        asPage
          ? ''
          : `<div class="byline"><span>${esc(fmtDate(post.date))}</span>${post.location ? `<span>· ${esc(post.location)}</span>` : ''}<span>· ${Math.max(1, Math.round((meta.words || 0) / 230))} min read</span>${
              isOwner() ? `<a href="#/studio/edit/${encodeURIComponent(post.id)}">· Edit</a>` : ''
            }</div>`
      }
    </header>
    ${coverHtml}
    <div class="prose">${renderMarkdown(post.body, ctx)}</div>
    ${
      asPage
        ? isOwner()
          ? `<p class="mono"><a href="#/studio/edit/${encodeURIComponent(post.id)}">Edit this page</a></p>`
          : ''
        : `<footer class="article-foot">
      ${tagLinks(post.tags)}
      <div class="pager">
        ${newer ? `<a href="${href(newer)}"><small>← Newer</small>${esc(newer.title)}</a>` : '<span></span>'}
        ${older ? `<a href="${href(older)}"><small>Older →</small>${esc(older.title)}</a>` : '<span></span>'}
      </div>
    </footer>`
    }
  </article>`;
  hydrateMedia(root, post);
  enableLightbox(root);
}

// ---------- threads ----------
export function threadsView(root) {
  const counts = {};
  for (const m of entries()) for (const t of m.tags || []) counts[t] = (counts[t] || 0) + 1;
  const tags = Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]));
  const max = Math.max(1, ...tags.map((t) => t[1]));
  const kinds = Object.keys(KINDS).filter((k) => k !== 'page');
  root.innerHTML = `
  <div class="section-head"><h2>Threads</h2><span class="mono muted">${tags.length} threads</span></div>
  ${
    tags.length
      ? `<div class="cloud">${tags
          .map(([t, n]) => `<a href="#/journal?tag=${encodeURIComponent(t)}" style="font-size:${(1 + (n / max) * 1.8).toFixed(2)}rem;font-weight:${400 + Math.round((n / max) * 400)}">${esc(t)}<small>${n}</small></a>`)
          .join('')}</div>`
      : '<div class="empty">No threads yet — add tags to entries.</div>'
  }
  <div class="section-head"><h2>By Kind</h2></div>
  <div class="columns">${kinds
    .map((k) => {
      const n = entries().filter((m) => m.kind === k).length;
      return `<a class="card" href="#/journal?kind=${k}"><div class="card-meta">${kindStamp(k)}</div><h3>${n} ${KINDS[k].label.toLowerCase()}${n === 1 ? '' : k === 'reflect' || k === 'milestone' || k === 'artifact' ? 's' : ''}</h3></a>`;
    })
    .join('')}</div>`;
}

// ---------- about ----------
export function aboutView(root) {
  if (S.byId.has('about')) return postView(root, 'about', { asPage: true });
  root.innerHTML = `
  <article class="article">
    <header class="article-head"><div class="kicker">Colophon</div><h1>About this journal</h1>
    <p class="dek">A single home for a lifetime of learning and teaching.</p></header>
    <div class="prose">
      <p>This is the source of truth for my journey: the things I have learned, the things I have taught, and the artifacts collected along the way. I believe learning and teaching are the highest level of life. Everything else is either a reward or a byproduct.</p>
      <p>Some pages are open to everyone. Some are <strong>protected</strong> and readable by people I give an access code to. Some are <strong>private</strong> and kept only for me. Sealed pages stay encrypted until the right key opens them, both here and in the repository behind the site.</p>
      <p>If you have an access code, use the <em>Unlock</em> button at the top of the page. If you'd like to say hello, please sign the <a href="#/guestbook">guestbook</a>.</p>
    </div>
    ${isOwner() ? '<p class="mono">Tip: create an entry with id <code>about</code> (kind “page”) to replace this text.</p>' : ''}
  </article>`;
}

export function notFound(root, msg) {
  root.innerHTML = `<div class="empty"><h2 style="font-style:normal">This page is missing or sealed.</h2><p>${esc(msg || 'It may have moved, or it may be locked.')}</p><p><a class="btn ghost" href="#/journal">Back to the journal</a></p></div>`;
}
