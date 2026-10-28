import { S, api } from './session.js';
import { esc, $, toast, turnstileWidget } from './util.js';

export async function guestbookView(root) {
  const configured = !!S.cfg.workerUrl;
  root.innerHTML = `
  <div class="section-head"><h2>The Guestbook</h2><span class="mono muted">Sign it, leave a note, say hello</span></div>
  <div class="gb">
    <form class="gb-form" id="gb-form" autocomplete="off">
      <div class="kicker">Leave your mark</div>
      <h3 style="margin:.2rem 0 1rem;font-size:1.5rem">Dear ${esc(S.cfg.author || 'Canvito')},</h3>
      <label class="f"><span>Your name</span><input class="t" name="name" maxlength="60" required></label>
      <label class="f"><span>Where are you from? (optional)</span><input class="t" name="from" maxlength="60"></label>
      <label class="f"><span>Message</span><textarea class="t" name="message" maxlength="2000" required></textarea></label>
      <label class="hp" aria-hidden="true">Website <input name="website" tabindex="-1" autocomplete="off"></label>
      <label class="check"><input type="checkbox" name="private"> Private note (only ${esc(S.cfg.author || 'the owner')} can read it)</label>
      <div class="ts" id="gb-ts"></div>
      <div class="err" id="gb-err"></div>
      <button class="btn" type="submit" ${configured ? '' : 'disabled'}>Sign the guestbook</button>
      ${configured ? '<p class="mono muted small" style="margin-top:.8rem">Notes appear after a quick review.</p>' : '<p class="mono muted small">The guestbook opens once the access service is deployed.</p>'}
    </form>
    <div class="gb-notes" id="gb-notes"><div class="loading"><span class="quill"></span>Gathering notes…</div></div>
  </div>`;

  const notes = $('#gb-notes', root);
  if (configured) {
    api('/api/guestbook')
      .then(({ entries }) => {
        notes.innerHTML = entries.length
          ? entries
              .map(
                (e) => `<article class="note"><p>${esc(e.message)}</p><footer><b>${esc(e.name)}</b>${e.from ? `${esc(e.from)} · ` : ''}${esc(new Date(e.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))}</footer></article>`,
              )
              .join('')
          : '<div class="empty">No signatures yet. Be the first.</div>';
      })
      .catch((e) => (notes.innerHTML = `<div class="empty">${esc(e.message)}</div>`));
  } else notes.innerHTML = '<div class="empty">No signatures yet.</div>';

  if (!configured) return;
  if (!S.cfg.turnstileSiteKey) $('#gb-ts', root).remove();
  const ts = await turnstileWidget($('#gb-ts', root), S.cfg.turnstileSiteKey).catch(() => ({ token: () => '', reset() {} }));
  const form = $('#gb-form', root);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const btn = form.querySelector('button[type=submit]');
    const err = $('#gb-err', root);
    err.textContent = '';
    btn.disabled = true;
    try {
      const r = await api('/api/guestbook', {
        method: 'POST',
        body: { name: fd.get('name'), from: fd.get('from'), message: fd.get('message'), website: fd.get('website'), private: !!fd.get('private'), turnstileToken: ts.token() },
      });
      form.reset();
      toast(r.pending ? 'Thank you! Your note will appear after review.' : 'Thank you for signing!');
      if (!r.pending) guestbookView(root);
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
      ts.reset();
    }
  });
}
