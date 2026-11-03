import { S, boot, onChange, unlock, authorSignIn, signOut, isOwner, trackVisit } from './session.js';
import { homeView, journalView, postView, threadsView, aboutView, notFound } from './views.js';
import { guestbookView } from './guestbook.js';
import { esc, $, $$, modal, toast, roman, relTime, turnstileWidget, LOCK_SVG } from './util.js';
import { t, lang, setLang, onLangChange, locale, cfgText } from './i18n.js';

const app = $('#app');

// ---------- theme ----------
const THEME_KEY = 'canvito.theme';
function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  document.querySelector('meta[name=theme-color]').content = mode === 'night' ? '#15120e' : '#f3eee3';
}
applyTheme(localStorage.getItem(THEME_KEY) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day'));
$('#theme-toggle').addEventListener('click', () => {
  const mode = document.documentElement.dataset.theme === 'night' ? 'day' : 'night';
  localStorage.setItem(THEME_KEY, mode);
  applyTheme(mode);
});

// ---------- language ----------
// Static text in index.html carries its English source in data-i18n (text), data-i18n-title/-aria/-placeholder.
function applyStaticText() {
  for (const el of $$('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of $$('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of $$('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of $$('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const b of $$('.lang-switch [data-lang]')) b.setAttribute('aria-pressed', b.dataset.lang === lang);
}
$('.lang-switch').addEventListener('click', (e) => {
  const b = e.target.closest('[data-lang]');
  if (b) setLang(b.dataset.lang);
});
applyStaticText();
onLangChange(() => {
  applyStaticText();
  route();
});

// ---------- masthead ----------
// "×" in the title is a symbol read as "by" (as in 3 × 4).
const brandTitle = (s) => esc(s).replaceAll('×', '<span class="brand-x" aria-hidden="true">×</span><span class="sr-only">by</span>');
const siteTitle = () => cfgText(S.cfg, 'title') || 'Little × Little';

function renderChrome() {
  const entries = S.metas.filter((m) => m.kind !== 'page');
  const first = entries.length ? +entries[entries.length - 1].date.slice(0, 4) : new Date().getFullYear();
  const vol = new Date().getFullYear() - first + 1;
  $('#dateline').textContent = `${new Date().toLocaleDateString(locale(), { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} · ${t('Vol. {v} · No. {n}', { v: roman(vol), n: entries.length })}`;
  $('#brand-title').innerHTML = brandTitle(siteTitle());
  const byline = cfgText(S.cfg, 'byline');
  $('#brand-byline').textContent = byline;
  $('#brand-byline').hidden = !byline;
  const acc = $('#access');
  if (S.mode === 'owner') acc.innerHTML = `<span class="seal private">${LOCK_SVG}</span><span>${esc(t('Author'))}</span><button type="button" data-lock>${esc(t('Lock'))}</button>`;
  else if (S.mode === 'guest')
    acc.innerHTML = `<span class="seal">${LOCK_SVG}</span><span title="${esc(t('Access ends {date}', { date: new Date(S.guest.exp).toLocaleString(locale()) }))}">${esc(S.guest.label || t('Guest'))} · ${esc(t('ends {when}', { when: relTime(S.guest.exp) }))}</span><button type="button" data-lock>${esc(t('Leave'))}</button>`;
  else acc.innerHTML = `<button type="button" data-unlock>${esc(t('Unlock'))}</button>`;
  $$('.owner-only').forEach((el) => (el.hidden = !isOwner()));
}

$('#access').addEventListener('click', async (e) => {
  if (e.target.closest('[data-unlock]')) openUnlock();
  if (e.target.closest('[data-lock]')) {
    await signOut();
    toast(t('Journal locked.'));
    if (location.hash.startsWith('#/studio')) location.hash = '#/';
  }
});

// ---------- author auto-lock ----------
// After ownerIdleMinutes (config, default 30) without input, the author gets 60 s to say "keep working", then the journal locks.
let lastActive = Date.now();
let idlePrompt = null;
for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(ev, () => (lastActive = Date.now()), { capture: true, passive: true });
async function lockForInactivity() {
  await signOut();
  toast(t('Locked after inactivity. Unlock again with your passphrase.'), 6000);
  if (location.hash.startsWith('#/studio')) location.hash = '#/';
}
function checkIdle() {
  if (!isOwner() || idlePrompt || Date.now() - lastActive < (Number(S.cfg.ownerIdleMinutes) || 30) * 60_000) return;
  let left = 60;
  let tick;
  idlePrompt = modal(
    `<h2>${esc(t('Still there?'))}</h2><p>${t('The journal locks in <b id="idle-left">{n}</b> seconds to keep your entries safe.', { n: left })}</p><div class="btn-row"><button class="btn" type="button" data-stay>${esc(t('Keep working'))}</button><button class="btn ghost" type="button" data-lock-now>${esc(t('Lock now'))}</button></div>`,
    {
      onClose: () => {
        clearInterval(tick);
        idlePrompt = null;
        lastActive = Date.now();
      },
    },
  );
  const p = idlePrompt;
  p.el.querySelector('[data-stay]').onclick = () => p.close();
  p.el.querySelector('[data-lock-now]').onclick = () => (p.close(), lockForInactivity());
  tick = setInterval(() => {
    left--;
    const el = p.el.querySelector('#idle-left');
    if (el) el.textContent = left;
    if (left <= 0) {
      p.close();
      lockForInactivity();
    }
  }, 1000);
}
setInterval(checkIdle, 15_000);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && checkIdle());

async function openUnlock() {
  const m = modal(`
    <div class="seal seal-big">${LOCK_SVG}</div>
    <h2 style="text-align:center">${esc(t('Unlock the journal'))}</h2>
    <p class="muted" style="text-align:center;font-size:.98rem">${esc(t('Enter the access code you were given.'))}</p>
    <form id="unlock-form" autocomplete="off">
      <label class="f"><span>${esc(t('Access code'))}</span><input class="t" type="password" name="secret" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
      <div class="ts" id="unlock-ts"></div>
      <div class="err" id="unlock-err"></div>
      <button class="btn" type="submit" style="width:100%;justify-content:center">${esc(t('Unlock'))}</button>
    </form>
    <details class="author-signin" style="margin-top:1.2rem">
      <summary class="mono muted small" style="cursor:pointer">${esc(t('Author sign-in on a new device'))}</summary>
      <form id="author-form" autocomplete="off" style="margin-top:.8rem">
        <label class="f"><span>${esc(t('Passphrase'))}</span><input class="t" type="password" name="pass" autocomplete="off" required></label>
        <label class="f"><span>${esc(t('GitHub token (both repos, Contents read/write)'))}</span><input class="t" type="password" name="token" autocomplete="off" placeholder="github_pat_…" required></label>
        <div class="err" id="author-err"></div>
        <button class="btn ghost" type="submit" style="width:100%;justify-content:center">${t('Sign in &amp; remember this device')}</button>
      </form>
    </details>`);
  const noTs = { token: () => '', reset() {} };
  const ts = S.cfg.workerUrl ? await turnstileWidget($('#unlock-ts', m.el), S.cfg.turnstileSiteKey, 'redeem').catch(() => noTs) : noTs;
  if (!S.cfg.workerUrl || !S.cfg.turnstileSiteKey) $('#unlock-ts', m.el).remove();

  const busy = async (form, errEl, label, fn) => {
    const btn = form.querySelector('button[type=submit]');
    errEl.textContent = '';
    btn.disabled = true;
    btn.textContent = t('Checking…');
    try {
      await fn();
    } catch (ex) {
      errEl.textContent = t(ex.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  };

  const form = $('#unlock-form', m.el);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form, $('#unlock-err', m.el), esc(t('Unlock')), async () => {
      try {
        const r = await unlock(form.elements.secret.value, ts.token());
        m.close();
        toast(r.mode === 'owner' ? t('Welcome back. Everything is unsealed.') : t('Welcome{name}. Protected entries are now visible.', { name: r.label ? `, ${r.label}` : '' }));
      } catch (ex) {
        ts.reset();
        throw ex;
      }
    });
  });

  const author = $('#author-form', m.el);
  author.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(author, $('#author-err', m.el), t('Sign in &amp; remember this device'), async () => {
      await authorSignIn(author.elements.pass.value, author.elements.token.value);
      m.close();
      toast(t('Welcome back. This device will remember you; next time just use your passphrase.'));
    });
  });
}
// ---------- search ----------
$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#search').value.trim();
  location.hash = q ? `#/journal?q=${encodeURIComponent(q)}` : '#/journal';
});
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = e.target.value.trim();
    if (q.length >= 2 || (!q && location.hash.startsWith('#/journal?q='))) location.hash = q ? `#/journal?q=${encodeURIComponent(q)}` : '#/journal';
  }, 350);
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) {
    e.preventDefault();
    $('#search').focus();
  }
});

// ---------- router ----------
let lastPath = null;
async function route() {
  const raw = location.hash.slice(1) || '/';
  const [pathPart, query = ''] = raw.split('?');
  if (!pathPart.startsWith('/')) return; // in-page anchor (e.g. #y-2019)
  const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(query);
  const section = parts[0] || 'home';
  $$('.nav a[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (section === 'p' ? 'journal' : section)));
  if (section === 'journal' && !params.get('q') && document.activeElement !== $('#search')) $('#search').value = '';
  if (section !== 'journal' && document.activeElement !== $('#search')) $('#search').value = '';
  if (section === 'journal' && params.get('q') && document.activeElement !== $('#search')) $('#search').value = params.get('q');
  document.title = siteTitle();
  renderChrome();

  const view = document.createElement('div');
  view.className = 'view';
  app.replaceChildren(view);
  try {
    if (section === 'home') homeView(view);
    else if (section === 'journal') journalView(view, params);
    else if (section === 'p' && parts[1]) await postView(view, parts[1]);
    else if (section === 'threads') threadsView(view);
    else if (section === 'guestbook') await guestbookView(view);
    else if (section === 'about') await aboutView(view);
    else if (section === 'studio') {
      const { studioView } = await import('./studio.js');
      await studioView(view, parts[1], parts[2]);
    } else notFound(view);
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="empty">${esc(t('Something went wrong: {msg}', { msg: e.message }))}</div>`;
  }
  trackVisit(pathPart);
  if (lastPath !== pathPart) {
    window.scrollTo({ top: 0, behavior: 'instant' });
    lastPath = pathPart;
  }
}

window.addEventListener('hashchange', route);
onChange(() => route());

boot()
  .then(route)
  .catch((e) => {
    console.error(e);
    app.innerHTML = `<div class="empty">${esc(t('The journal could not be opened: {msg}', { msg: e.message }))}</div>`;
  });
