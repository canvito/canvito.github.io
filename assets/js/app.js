import { S, boot, onChange, unlock, authorSignIn, signOut, isOwner } from './session.js';
import { homeView, journalView, postView, threadsView, aboutView, notFound } from './views.js';
import { guestbookView } from './guestbook.js';
import { esc, $, $$, modal, toast, roman, relTime, turnstileWidget, LOCK_SVG } from './util.js';

const app = $('#app');

// ---------- theme ----------
const THEME_KEY = 'canvito.theme';
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name=theme-color]').content = t === 'night' ? '#15120e' : '#f3eee3';
}
applyTheme(localStorage.getItem(THEME_KEY) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day'));
$('#theme-toggle').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'night' ? 'day' : 'night';
  localStorage.setItem(THEME_KEY, t);
  applyTheme(t);
});

// ---------- masthead ----------
function renderChrome() {
  const entries = S.metas.filter((m) => m.kind !== 'page');
  const first = entries.length ? +entries[entries.length - 1].date.slice(0, 4) : new Date().getFullYear();
  const vol = new Date().getFullYear() - first + 1;
  $('#dateline').textContent = `${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} · Vol. ${roman(vol)} · No. ${entries.length}`;
  if (S.cfg.title) {
    $('#brand-title').textContent = S.cfg.title;
    document.title = S.cfg.title;
  }
  if (S.cfg.tagline) $('#brand-tag').textContent = S.cfg.tagline;
  const acc = $('#access');
  if (S.mode === 'owner') acc.innerHTML = `<span class="seal private">${LOCK_SVG}</span><span>Author</span><button type="button" data-lock>Lock</button>`;
  else if (S.mode === 'guest')
    acc.innerHTML = `<span class="seal">${LOCK_SVG}</span><span title="Access ends ${esc(new Date(S.guest.exp).toLocaleString())}">${esc(S.guest.label || 'Guest')} · ends ${esc(relTime(S.guest.exp))}</span><button type="button" data-lock>Leave</button>`;
  else acc.innerHTML = `<button type="button" data-unlock>Unlock</button>`;
  $$('.owner-only').forEach((el) => (el.hidden = !isOwner()));
}

$('#access').addEventListener('click', async (e) => {
  if (e.target.closest('[data-unlock]')) openUnlock();
  if (e.target.closest('[data-lock]')) {
    await signOut();
    toast('Journal locked.');
    if (location.hash.startsWith('#/studio')) location.hash = '#/';
  }
});

async function openUnlock() {
  const m = modal(`
    <div class="seal seal-big">${LOCK_SVG}</div>
    <h2 style="text-align:center">Unlock the journal</h2>
    <p class="muted" style="text-align:center;font-size:.98rem">Enter the access code you were given.</p>
    <form id="unlock-form" autocomplete="off">
      <label class="f"><span>Access code</span><input class="t" type="password" name="secret" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
      <div class="ts" id="unlock-ts"></div>
      <div class="err" id="unlock-err"></div>
      <button class="btn" type="submit" style="width:100%;justify-content:center">Unlock</button>
    </form>
    <details class="author-signin" style="margin-top:1.2rem">
      <summary class="mono muted small" style="cursor:pointer">Author sign-in on a new device</summary>
      <form id="author-form" autocomplete="off" style="margin-top:.8rem">
        <label class="f"><span>Passphrase</span><input class="t" type="password" name="pass" autocomplete="off" required></label>
        <label class="f"><span>GitHub token (both repos, Contents read/write)</span><input class="t" type="password" name="token" autocomplete="off" placeholder="github_pat_…" required></label>
        <div class="err" id="author-err"></div>
        <button class="btn ghost" type="submit" style="width:100%;justify-content:center">Sign in &amp; remember this device</button>
      </form>
    </details>`);
  const noTs = { token: () => '', reset() {} };
  const ts = S.cfg.workerUrl ? await turnstileWidget($('#unlock-ts', m.el), S.cfg.turnstileSiteKey).catch(() => noTs) : noTs;
  if (!S.cfg.workerUrl || !S.cfg.turnstileSiteKey) $('#unlock-ts', m.el).remove();

  const busy = async (form, errEl, label, fn) => {
    const btn = form.querySelector('button[type=submit]');
    errEl.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      await fn();
    } catch (ex) {
      errEl.textContent = ex.message;
    } finally {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  };

  const form = $('#unlock-form', m.el);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(form, $('#unlock-err', m.el), 'Unlock', async () => {
      try {
        const r = await unlock(form.elements.secret.value, ts.token());
        m.close();
        toast(r.mode === 'owner' ? 'Welcome back. Everything is unsealed.' : `Welcome${r.label ? `, ${r.label}` : ''}. Protected entries are now visible.`);
      } catch (ex) {
        ts.reset();
        throw ex;
      }
    });
  });

  const author = $('#author-form', m.el);
  author.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(author, $('#author-err', m.el), 'Sign in &amp; remember this device', async () => {
      await authorSignIn(author.elements.pass.value, author.elements.token.value);
      m.close();
      toast('Welcome back. This device will remember you; next time just use your passphrase.');
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
  if (section === 'journal' && params.get('q') && document.activeElement !== $('#search')) $('#search').value = params.get('q');
  document.title = S.cfg.title || 'Canvito Life Journey';
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
    else if (section === 'about') aboutView(view);
    else if (section === 'studio') {
      const { studioView } = await import('./studio.js');
      await studioView(view, parts[1], parts[2]);
    } else notFound(view);
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="empty">Something went wrong: ${esc(e.message)}</div>`;
  }
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
    app.innerHTML = `<div class="empty">The journal could not be opened: ${esc(e.message)}</div>`;
  });
