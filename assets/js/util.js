import { esc } from './markdown.js';

export { esc };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const monthName = (m) => MONTHS[m - 1];

export function parseDate(d) {
  const [y, m, rest] = String(d).split('-');
  const [day, time] = (rest || '').split('T');
  return { y: +y, m: m ? +m : null, d: day ? +day : null, time: time || null };
}

export function fmtDate(d, { short = false } = {}) {
  const p = parseDate(d);
  if (!p.m) return String(p.y);
  const mon = short ? MONTHS[p.m - 1].slice(0, 3) : MONTHS[p.m - 1];
  if (!p.d) return `${mon} ${p.y}`;
  let s = `${mon} ${p.d}, ${p.y}`;
  if (p.time && !short) {
    const [h, mi] = p.time.split(':').map(Number);
    s += ` · ${((h + 11) % 12) + 1}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  }
  return s;
}

export function weekday(d) {
  const p = parseDate(d);
  return p.d ? WD[new Date(p.y, p.m - 1, p.d).getDay()] : '';
}

export function roman(n) {
  const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, r] of map) while (n >= v) (s += r), (n -= v);
  return s || '—';
}

export function relTime(ts) {
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  return rtf.format(Math.round(diff / 86_400_000), 'day');
}

let toastTimer;
export function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

export function modal(html, { wide = false, onClose } = {}) {
  const root = $('#modal-root');
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true"><button class="icon-btn x" type="button" aria-label="Close">✕</button>${html}</div>`;
  const prev = document.activeElement;
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
    prev?.focus?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  back.addEventListener('click', (e) => e.target === back && close());
  back.querySelector('.x').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  root.append(back);
  const el = back.querySelector('.modal');
  (el.querySelector('input,textarea,button:not(.x)') || el).focus();
  return { el, close };
}

export function confirmDialog(message, label = 'Confirm') {
  return new Promise((resolve) => {
    let done = false;
    const m = modal(`<h2>Are you sure?</h2><p>${esc(message)}</p><div class="btn-row"><button class="btn danger" data-ok>${esc(label)}</button><button class="btn ghost" data-no>Cancel</button></div>`, {
      onClose: () => !done && resolve(false),
    });
    m.el.querySelector('[data-ok]').onclick = () => ((done = true), m.close(), resolve(true));
    m.el.querySelector('[data-no]').onclick = () => m.close();
  });
}

export const LOCK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>';
export const sealHtml = (tier, withLabel = false) =>
  tier === 'public' ? '' : `<span class="seal ${tier}" title="${tier === 'private' ? 'Private — only you' : 'Protected — shared by code'}">${LOCK_SVG}</span>${withLabel ? `<span class="seal-label" style="--s:var(--${tier})">${tier}</span>` : ''}`;

let tsLoading;
export function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  tsLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve(window.turnstile);
    s.onerror = () => reject(new Error('Could not load human check'));
    document.head.append(s);
  });
  return tsLoading;
}

// Renders a Turnstile widget; returns { token(), reset() }.
export async function turnstileWidget(el, sitekey) {
  if (!sitekey) return { token: () => '', reset() {} };
  let token = '';
  const ts = await loadTurnstile();
  const id = ts.render(el, {
    sitekey,
    theme: document.documentElement.dataset.theme === 'night' ? 'dark' : 'light',
    callback: (t) => (token = t),
    'expired-callback': () => (token = ''),
  });
  return { token: () => token, reset: () => ((token = ''), ts.reset(id)) };
}
