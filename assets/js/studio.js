// Owner-only Studio: write/edit/delete entries (committed straight to GitHub), access codes, guestbook moderation, settings.
import { renderMarkdown, mediaRefs } from './markdown.js';
import { KINDS, TIERS, DATE_RE } from './vault.js';
import { newRawKey } from './crypto.js';
import { S, api, getPost, ownerIO, ownerVault, refreshAfterWrite, authorSignIn, forgetDevice, signOut } from './session.js';
import { hydrateMedia } from './views.js';
import { esc, $, $$, toast, modal, confirmDialog, sealHtml, relTime } from './util.js';

const TABS = [
  ['', 'Entries'],
  ['new', 'New entry'],
  ['codes', 'Access codes'],
  ['guestbook', 'Guestbook'],
  ['settings', 'Settings'],
];

function tabs(active) {
  return `<nav class="studio-tabs">${TABS.map(([k, l]) => `<a href="#/studio${k ? `/${k}` : ''}" class="${active === k ? 'active' : ''}">${l}</a>`).join('')}</nav>`;
}

const writableIO = () => ownerIO();

const commitMsg = (verb, post) => (post.tier === 'public' ? `journal: ${verb} “${post.title}”` : `journal: ${verb} sealed entry`);

export async function studioView(root, sub, arg) {
  if (S.mode !== 'owner') {
    root.innerHTML = '<div class="empty">The Studio is for the journal’s author. Unlock with your passphrase.</div>';
    return;
  }
  if (sub === 'new' || sub === 'edit') return editorView(root, sub === 'edit' ? arg : null);
  if (sub === 'codes') return codesView(root);
  if (sub === 'guestbook') return gbAdminView(root);
  if (sub === 'settings') return settingsView(root);
  return entriesView(root);
}

// ---------- entries ----------
function entriesView(root) {
  const rows = (filter = '') =>
    S.metas
      .filter((m) => !filter || `${m.title} ${m.tags.join(' ')} ${m.id} ${m.tier} ${m.kind}`.toLowerCase().includes(filter))
      .map(
        (m) => `<tr>
        <td class="mono">${esc(m.date)}</td>
        <td><a href="#/p/${encodeURIComponent(m.id)}">${esc(m.title)}</a></td>
        <td><span class="stamp k-${m.kind}">${esc(KINDS[m.kind]?.stamp || m.kind)}</span></td>
        <td>${sealHtml(m.tier) || '<span class="mono muted">public</span>'}</td>
        <td class="actions"><a class="linkish" href="#/studio/edit/${encodeURIComponent(m.id)}">edit</a><button class="linkish" data-del="${esc(m.id)}">delete</button></td>
      </tr>`,
      )
      .join('');
  const counts = TIERS.map((t) => `${S.metas.filter((m) => m.tier === t).length} ${t}`).join(' · ');
  root.innerHTML = `${tabs('')}
    <div class="btn-row" style="justify-content:space-between;margin-bottom:1rem">
      <input class="t" id="flt" placeholder="Filter entries…" style="max-width:20rem">
      <span class="mono muted">${counts}</span>
      <a class="btn" href="#/studio/new">+ New entry</a>
    </div>
    <table class="table"><thead><tr><th>Date</th><th>Title</th><th>Kind</th><th>Access</th><th></th></tr></thead><tbody id="rows">${rows()}</tbody></table>`;
  $('#flt', root).addEventListener('input', (e) => ($('#rows', root).innerHTML = rows(e.target.value.toLowerCase())));
  root.addEventListener('click', async (e) => {
    const id = e.target.closest('[data-del]')?.dataset.del;
    if (!id) return;
    const m = S.byId.get(id);
    if (!(await confirmDialog(`Delete “${m.title}” and its attachments? (Git history still keeps old versions.)`, 'Delete'))) return;
    try {
      const io = writableIO();
      await ownerVault(io).deletePost(id);
      await io.commit(commitMsg('delete', m));
      toast('Deleted. The live site updates in about a minute.');
      await refreshAfterWrite();
    } catch (ex) {
      toast(ex.message, 6000);
    }
  });
}

// ---------- editor ----------
async function editorView(root, id) {
  let post = null;
  if (id) {
    root.innerHTML = '<div class="loading"><span class="quill"></span>Opening entry…</div>';
    post = await getPost(id).catch(() => null);
    if (!post) {
      root.innerHTML = `${tabs('')}<div class="empty">Entry not found.</div>`;
      return;
    }
  }
  const today = new Date();
  const draft = post
    ? structuredClone(post)
    : { title: '', date: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`, kind: 'learn', tier: 'public', tags: [], summary: '', cover: '', location: '', body: '', assets: [] };
  const pending = new Map();

  root.innerHTML = `${tabs(id ? '' : 'new')}
  <form id="ed" class="editor" autocomplete="off">
    <div>
      <label class="f"><span>Title</span><input class="t" name="title" required maxlength="200" value="${esc(draft.title)}"></label>
      <div class="grid-3">
        <label class="f"><span>Date (backdate freely)</span><input class="t" name="date" value="${esc(draft.date)}" placeholder="YYYY[-MM[-DD[THH:mm]]]" pattern="\\d{4}(-\\d{2}(-\\d{2}(T\\d{2}:\\d{2})?)?)?"></label>
        <label class="f"><span>Kind</span><select class="t" name="kind">${Object.keys(KINDS).map((k) => `<option value="${k}" ${draft.kind === k ? 'selected' : ''}>${KINDS[k].label}</option>`).join('')}</select></label>
        <label class="f"><span>Location</span><input class="t" name="location" value="${esc(draft.location)}"></label>
      </div>
      <div class="f"><span class="mono muted small" style="text-transform:uppercase;letter-spacing:.12em">Who can see it</span>
        <div class="tier-pick" style="margin-top:.3rem">${TIERS.map(
          (t) => `<label><input type="radio" name="tier" value="${t}" ${draft.tier === t ? 'checked' : ''}> ${sealHtml(t)} ${t === 'public' ? 'Public' : t === 'protected' ? 'Protected (access code)' : 'Private (only me)'}</label>`,
        ).join('')}</div>
      </div>
      <label class="f" style="margin-top:.9rem"><span>Summary / dek</span><input class="t" name="summary" maxlength="300" value="${esc(draft.summary)}"></label>
      <div class="grid-2">
        <label class="f"><span>Tags (comma separated)</span><input class="t" name="tags" value="${esc(draft.tags.join(', '))}"></label>
        <label class="f"><span>Cover (URL or upload)</span><span style="display:flex;gap:.4rem"><input class="t" name="cover" value="${esc(draft.cover)}"><button class="btn ghost" type="button" id="cover-up">Upload</button></span></label>
      </div>
      ${!id ? '<label class="f"><span>Custom id (optional, e.g. “about”)</span><input class="t" name="customId" pattern="[a-z0-9][a-z0-9-]{1,63}"></label>' : ''}
      <div class="toolbar" role="toolbar">
        <button type="button" data-md="**|**" title="Bold"><b>B</b></button>
        <button type="button" data-md="*|*" title="Italic"><i>I</i></button>
        <button type="button" data-md="==|==" title="Highlight">H̲</button>
        <button type="button" data-md="\n## |" title="Heading">H2</button>
        <button type="button" data-md="\n> |" title="Quote">“</button>
        <button type="button" data-md="\n> [!LESSON] Lesson learned\n> |" title="Lesson callout">Lesson</button>
        <button type="button" data-md="\n- |" title="List">•</button>
        <button type="button" data-md="[|](https://)" title="Link">Link</button>
        <button type="button" data-md="\n@[Caption](|)\n" title="Embed YouTube/Vimeo/Doc/link">Embed</button>
        <button type="button" data-md="\n\`\`\`\n|\n\`\`\`\n" title="Code">{ }</button>
        <button type="button" id="file-up" title="Photo, video, audio, PDF…">+ Media</button>
      </div>
      <textarea class="t" id="body-input" name="body" placeholder="Write in Markdown. Drop or paste photos, videos and documents here.">${esc(draft.body)}</textarea>
      <div class="assets-list" id="assets"></div>
      <input type="file" id="file-input" multiple hidden>
      <input type="file" id="cover-input" accept="image/*" hidden>
      <div class="err" id="ed-err"></div>
      <div class="btn-row">
        <button class="btn" type="submit">${id ? 'Save changes' : 'Publish entry'}</button>
        ${id ? `<a class="btn ghost" href="#/p/${encodeURIComponent(id)}">View</a><button class="btn danger" type="button" id="del">Delete</button>` : ''}
        <span class="mono muted small" id="ed-status"></span>
      </div>
    </div>
    <div>
      <div class="mono muted small" style="margin-bottom:.3rem;text-transform:uppercase;letter-spacing:.12em">Live preview</div>
      <div class="preview"><div class="prose" id="preview"></div></div>
    </div>
  </form>`;

  const form = $('#ed', root);
  const F = form.elements;
  const ta = $('#body-input', root);
  const tierNow = () => F.tier.value;

  const renderAssets = () => {
    const refs = new Set(mediaRefs(`${ta.value}\n${F.cover.value}`));
    $('#assets', root).innerHTML = draft.assets
      .filter((a) => refs.has(a.id))
      .map((a) => `<span title="media:${a.id}">${pending.has(a.id) ? '⬆ ' : ''}${esc(a.name)} · ${Math.max(1, Math.round(a.size / 1024))} KB</span>`)
      .join('');
  };
  let t;
  const preview = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const el = $('#preview', root);
      const ctx = { asset: (aid) => draft.assets.find((a) => a.id === aid) };
      el.innerHTML = renderMarkdown(ta.value, ctx) || '<p class="muted"><em>Nothing yet…</em></p>';
      hydrateMedia(el, { id: draft.id || '_draft', tier: draft.tier, assets: draft.assets }, new Map([...pending].map(([k, v]) => [k, v.url])));
      renderAssets();
    }, 200);
  };
  ta.addEventListener('input', preview);
  F.cover.addEventListener('input', renderAssets);
  preview();

  const insert = (text) => {
    const [before, after = ''] = text.split('|');
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const sel = ta.value.slice(s, e);
    ta.setRangeText(before + sel + after, s, e, 'end');
    if (!sel) ta.selectionStart = ta.selectionEnd = s + before.length;
    ta.focus();
    preview();
  };
  $$('[data-md]', root).forEach((b) => b.addEventListener('click', () => insert(b.dataset.md.replace(/\\n/g, '\n'))));

  const addFiles = async (files, asCover = false) => {
    const v = ownerVault();
    for (const file of files) {
      try {
        const asset = v.prepareAsset({ name: file.name, mime: file.type, size: file.size }, tierNow());
        pending.set(asset.id, { bytes: new Uint8Array(await file.arrayBuffer()), url: URL.createObjectURL(file) });
        draft.assets.push(asset);
        if (asCover) F.cover.value = `media:${asset.id}`;
        else insert(`${asset.mime.startsWith('image/') ? '\n!' : '\n@'}[${file.name.replace(/\.[^.]+$/, '').replace(/[[\]]/g, '')}](media:${asset.id})\n|`);
        if (file.size > 25 * 1048576) toast('Large file — consider YouTube/Vimeo (unlisted) for long videos.', 6000);
      } catch (e) {
        toast(e.message, 6000);
      }
    }
    preview();
  };
  $('#file-up', root).onclick = () => $('#file-input', root).click();
  $('#cover-up', root).onclick = () => $('#cover-input', root).click();
  $('#file-input', root).onchange = (e) => addFiles([...e.target.files]);
  $('#cover-input', root).onchange = (e) => addFiles([...e.target.files], true);
  ta.addEventListener('dragover', (e) => (e.preventDefault(), ta.classList.add('drag')));
  ta.addEventListener('dragleave', () => ta.classList.remove('drag'));
  ta.addEventListener('drop', (e) => {
    ta.classList.remove('drag');
    if (e.dataTransfer?.files?.length) {
      e.preventDefault();
      addFiles([...e.dataTransfer.files]);
    }
  });
  ta.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });

  $('#del', root)?.addEventListener('click', async () => {
    if (!(await confirmDialog(`Delete “${post.title}”?`, 'Delete'))) return;
    try {
      const io = writableIO();
      await ownerVault(io).deletePost(post.id);
      await io.commit(commitMsg('delete', post));
      await refreshAfterWrite();
      toast('Deleted.');
      location.hash = '#/studio';
    } catch (e) {
      toast(e.message, 6000);
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#ed-err', root);
    const status = $('#ed-status', root);
    const btn = form.querySelector('button[type=submit]');
    err.textContent = '';
    if (!DATE_RE.test(F.date.value.trim())) return (err.textContent = 'Date must look like 2014, 2014-09, 2014-09-21 or 2014-09-21T18:30');
    btn.disabled = true;
    try {
      const io = writableIO();
      const v = ownerVault(io);
      const tier = tierNow();
      const body = ta.value;
      const refs = new Set(mediaRefs(`${body}\n${F.cover.value}`));
      status.textContent = 'Encrypting & uploading…';
      for (const a of draft.assets) {
        if (!pending.has(a.id) || !refs.has(a.id)) continue;
        if (tier === 'public') delete a.key;
        else a.key ||= newRawKey();
        await v.writeAsset(a, pending.get(a.id).bytes);
      }
      const saved = await v.savePost({
        id: post?.id || F.customId?.value.trim() || undefined,
        title: F.title.value,
        date: F.date.value.trim(),
        kind: F.kind.value,
        tier,
        tags: F.tags.value,
        summary: F.summary.value,
        cover: F.cover.value.trim(),
        location: F.location.value,
        body,
        assets: draft.assets,
      });
      status.textContent = 'Committing…';
      await io.commit(commitMsg(post ? 'update' : 'add', saved));
      pending.forEach((p) => URL.revokeObjectURL(p.url));
      await refreshAfterWrite();
      toast('Saved. The live site updates in about a minute.');
      location.hash = `#/p/${encodeURIComponent(saved.id)}`;
    } catch (ex) {
      err.textContent = ex.message;
      status.textContent = '';
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------- access codes ----------
async function codesView(root) {
  root.innerHTML = `${tabs('codes')}
  <div class="grid-2" style="gap:2rem;align-items:start">
    <form class="panel" id="code-form">
      <h3>Issue an access code</h3>
      <p class="muted" style="font-size:.95rem">Lets someone read <strong>protected</strong> entries. Private entries are never shared.</p>
      <label class="f"><span>Who is it for?</span><input class="t" name="label" maxlength="80" placeholder="e.g. Mom, Class of 2026" required></label>
      <label class="f"><span>Type</span><select class="t" name="type">
        <option value="once">One-time: works for a single sign-in (${esc(String(S.cfg.sessionHours || 12))} h session)</option>
        <option value="timed">Time-bound: works until a date</option>
        <option value="permanent">Permanent: until revoked</option>
      </select></label>
      <div class="grid-2">
        <label class="f"><span>Expires</span><input class="t" type="datetime-local" name="expires"></label>
        <label class="f"><span>Max sign-ins (0 = ∞)</span><input class="t" type="number" min="0" name="uses" value="0"></label>
      </div>
      <label class="f"><span>Custom code (optional, 10+ letters/digits)</span><input class="t" name="code" maxlength="64"></label>
      <div class="err" id="code-err"></div>
      <button class="btn" type="submit">Generate code</button>
    </form>
    <div><h3 style="margin-top:0">Issued codes</h3><div id="codes"><div class="loading"><span class="quill"></span>Loading…</div></div></div>
  </div>`;
  const list = $('#codes', root);
  const load = async () => {
    try {
      const { codes } = await api('/api/admin/codes', { auth: 'admin' });
      list.innerHTML = codes.length
        ? `<table class="table"><thead><tr><th>For</th><th>Type</th><th>Status</th><th>Used</th><th>Expires</th><th></th></tr></thead><tbody>${codes
            .map(
              (c) => `<tr><td>${esc(c.label)}</td><td class="mono">${esc(c.type)}</td><td><span class="pill ${c.status}">${c.status}</span></td>
          <td class="mono">${c.uses}${c.maxUses ? `/${c.maxUses}` : ''}${c.lastUsedAt ? `<br><small class="muted">${esc(relTime(Date.parse(c.lastUsedAt)))}</small>` : ''}</td>
          <td class="mono small">${c.expiresAt ? esc(new Date(c.expiresAt).toLocaleString()) : '—'}</td>
          <td class="actions">${c.status === 'active' ? `<button class="linkish" data-revoke="${c.id}">revoke</button>` : `<button class="linkish" data-purge="${c.id}">remove</button>`}</td></tr>`,
            )
            .join('')}</tbody></table>`
        : '<div class="empty">No codes issued yet.</div>';
    } catch (e) {
      list.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  };
  load();
  list.addEventListener('click', async (e) => {
    const r = e.target.closest('[data-revoke],[data-purge]');
    if (!r) return;
    const purge = !!r.dataset.purge;
    if (!purge && !(await confirmDialog('Revoke this code? Anyone using it loses access immediately.', 'Revoke'))) return;
    try {
      await api(`/api/admin/codes/${r.dataset.revoke || r.dataset.purge}${purge ? '?purge=1' : ''}`, { method: 'DELETE', auth: 'admin' });
      load();
    } catch (ex) {
      toast(ex.message);
    }
  });
  const form = $('#code-form', root);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#code-err', root).textContent = '';
    try {
      const c = await api('/api/admin/codes', {
        method: 'POST',
        auth: 'admin',
        body: { label: form.elements.label.value, type: form.elements.type.value, expiresAt: form.elements.expires.value ? new Date(form.elements.expires.value).toISOString() : undefined, maxUses: form.elements.uses.value, code: form.elements.code.value || undefined },
      });
      const site = location.origin + location.pathname;
      const share = `You're invited to read my journal: ${site}\nClick “Unlock” and enter the code: ${c.code}${c.expiresAt ? `\n(valid until ${new Date(c.expiresAt).toLocaleString()})` : ''}`;
      const m = modal(`<div class="seal seal-big">✶</div><h2 style="text-align:center">Code for ${esc(c.label)}</h2>
        <div class="code-reveal">${esc(c.code)}</div>
        <p class="muted small" style="text-align:center">Shown only once. Copy it now.</p>
        <div class="btn-row" style="justify-content:center"><button class="btn" data-copy>Copy invitation</button><button class="btn ghost" data-copy-code>Copy code</button></div>`);
      m.el.querySelector('[data-copy]').onclick = () => navigator.clipboard.writeText(share).then(() => toast('Invitation copied'));
      m.el.querySelector('[data-copy-code]').onclick = () => navigator.clipboard.writeText(c.code).then(() => toast('Code copied'));
      form.reset();
      load();
    } catch (ex) {
      $('#code-err', root).textContent = ex.message;
    }
  });
}

// ---------- guestbook moderation ----------
async function gbAdminView(root) {
  root.innerHTML = `${tabs('guestbook')}<div id="gb-admin"><div class="loading"><span class="quill"></span>Loading…</div></div>`;
  const box = $('#gb-admin', root);
  const load = async () => {
    try {
      const { queue, published } = await api('/api/admin/guestbook', { auth: 'admin' });
      const row = (e, pub) => `<tr><td class="mono small">${esc(new Date(e.createdAt).toLocaleString())}</td><td><strong>${esc(e.name)}</strong>${e.from ? `<br><small class="muted">${esc(e.from)}</small>` : ''}</td>
        <td style="white-space:pre-wrap">${e.private ? '<span class="pill revoked">private</span> ' : ''}${esc(e.message)}</td>
        <td class="actions">${!pub && !e.private ? `<button class="linkish" data-approve="${e.id}">approve</button>` : ''}<button class="linkish" data-remove="${e.id}">delete</button></td></tr>`;
      box.innerHTML = `<h3>Awaiting review &amp; private notes (${queue.length})</h3>
        ${queue.length ? `<table class="table"><tbody>${queue.map((e) => row(e, false)).join('')}</tbody></table>` : '<div class="empty">Inbox zero.</div>'}
        <h3 style="margin-top:2rem">Published (${published.length})</h3>
        ${published.length ? `<table class="table"><tbody>${published.map((e) => row(e, true)).join('')}</tbody></table>` : '<div class="empty">Nothing published yet.</div>'}`;
    } catch (e) {
      box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  };
  load();
  box.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-approve]')?.dataset.approve;
    const d = e.target.closest('[data-remove]')?.dataset.remove;
    try {
      if (a) await api(`/api/admin/guestbook/${a}/approve`, { method: 'POST', auth: 'admin' });
      else if (d) {
        if (!(await confirmDialog('Delete this note?', 'Delete'))) return;
        await api(`/api/admin/guestbook/${d}`, { method: 'DELETE', auth: 'admin' });
      } else return;
      load();
    } catch (ex) {
      toast(ex.message);
    }
  });
}

// ---------- settings ----------
async function settingsView(root) {
  const repo = S.cfg.repo || {};
  const vault = S.cfg.vault || {};
  root.innerHTML = `${tabs('settings')}
  <div class="grid-2" style="gap:2rem;align-items:start">
    <form class="panel" id="pat-form">
      <h3>Where your journal lives</h3>
      <p style="font-size:.95rem">Public entries: <strong>${esc(repo.owner)}/${esc(repo.name)}</strong> (public repo).<br>
      Protected &amp; private entries and your keyring: <strong>${esc(vault.owner)}/${esc(vault.name)}</strong> (private repo, encrypted).</p>
      <h3>Replace the GitHub token on this device</h3>
      <p style="font-size:.95rem">Use a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a> limited to those two repositories with <strong>Contents: Read and write</strong>. It is stored on this device, sealed with your passphrase.</p>
      <label class="f"><span>Passphrase</span><input class="t" type="password" name="pass" autocomplete="off" required></label>
      <label class="f"><span>New GitHub token</span><input class="t" type="password" name="pat" placeholder="github_pat_…" autocomplete="off" required></label>
      <div class="err" id="pat-err"></div>
      <div class="btn-row"><button class="btn" type="submit">Verify &amp; save</button><button class="btn ghost" type="button" id="forget">Forget this device</button></div>
    </form>
    <div class="panel">
      <h3>Access service</h3>
      <p class="mono small" id="health">Checking…</p>
      <h3 style="margin-top:1.5rem">Session</h3>
      <p style="font-size:.95rem">You're signed in as the author in this tab. Closing the tab locks the journal again.</p>
      <button class="btn danger" type="button" id="lock">Lock now</button>
    </div>
  </div>`;
  api('/api/health')
    .then((h) => ($('#health', root).textContent = `Online · Turnstile ${h.turnstile ? 'on' : 'OFF'} · Protected key ${h.protected ? 'set' : 'MISSING'} · Vault token ${h.vault ? 'set' : 'MISSING'} · ${S.cfg.workerUrl}`))
    .catch((e) => ($('#health', root).textContent = e.message));
  $('#lock', root).onclick = () => signOut().then(() => (location.hash = '#/'));
  $('#forget', root).addEventListener('click', async () => {
    if (!(await confirmDialog('Remove the saved token from this device? You will need the token again to sign in here.', 'Forget'))) return;
    forgetDevice();
    await signOut();
    location.hash = '#/';
    toast('This device no longer remembers you.');
  });
  $('#pat-form', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      await authorSignIn(f.pass.value, f.pat.value);
      toast('Token verified and saved.');
      location.hash = '#/studio/settings';
    } catch (ex) {
      $('#pat-err', root).textContent = ex.message;
    }
  });
}