// Small, dependency-free, XSS-safe Markdown renderer shared by the site, the CLI and tests.
// Everything is HTML-escaped; only a fixed set of tags/attributes is ever emitted.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function safeUrl(raw) {
  // Browsers ignore control chars/whitespace inside schemes ("java\tscript:"), so strip them before checking.
  const u = String(raw ?? '').replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
  if (!u) return null;
  if (/^media:[a-z0-9]{4,40}$/i.test(u)) return u;
  if (/^(https?:\/\/|mailto:)/i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('//') || u.startsWith('\\')) return null;
  return u;
}

const slug = (s) => String(s).toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

const ICON_FILE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h8l6 6v14H6z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M14 2v6h6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
const ICON_LINK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

function mediaTag(id, alt, ctx) {
  const a = ctx.asset?.(id);
  const mime = a?.mime || 'image/*';
  const label = esc(alt || a?.name || '');
  if (mime.startsWith('image/')) return `<img data-asset="${esc(id)}" alt="${label}" loading="lazy">`;
  if (mime.startsWith('video/')) return `<video controls preload="metadata" playsinline data-asset="${esc(id)}" aria-label="${label}"></video>`;
  if (mime.startsWith('audio/')) return `<audio controls preload="metadata" data-asset="${esc(id)}" aria-label="${label}"></audio>`;
  return `<a class="file-card" href="#" data-asset="${esc(id)}" data-download="${esc(a?.name || alt || 'file')}">${ICON_FILE}<span>${label || 'Attachment'}</span><small>${esc(a?.ext?.toUpperCase() || 'FILE')}</small></a>`;
}

function image(alt, url, title, ctx) {
  const u = safeUrl(url);
  if (!u) return esc(alt);
  if (u.startsWith('media:')) return mediaTag(u.slice(6), alt, ctx);
  return `<img src="${esc(u)}" alt="${esc(alt)}"${title ? ` title="${esc(title)}"` : ''} loading="lazy" referrerpolicy="no-referrer">`;
}

function link(text, url, title, ctx) {
  const u = safeUrl(url);
  if (!u) return text;
  if (u.startsWith('media:')) return `<a href="#" data-asset="${esc(u.slice(6))}" data-download="${esc(ctx.asset?.(u.slice(6))?.name || 'file')}">${text}</a>`;
  const ext = /^(https?:|mailto:)/i.test(u);
  return `<a href="${esc(u)}"${title ? ` title="${esc(title)}"` : ''}${ext ? ' target="_blank" rel="noopener noreferrer nofollow"' : ''}>${text}</a>`;
}

const INLINE_RE = new RegExp(
  [
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/.source, // 1-3 image
    /\[((?:[^[\]]|\[[^\]]*\])+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/.source, // 4-6 link
    /<((?:https?:\/\/|mailto:)[^>\s]+)>/.source, // 7 autolink
    /(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/.source, // 8 bare url
    /\*\*(?=\S)([\s\S]*?\S)\*\*/.source, // 9 strong
    /(?<![A-Za-z0-9_])__(?=\S)([\s\S]*?\S)__(?![A-Za-z0-9_])/.source, // 10 strong
    /~~(?=\S)([\s\S]*?\S)~~/.source, // 11 strike
    /==(?=\S)([\s\S]*?\S)==/.source, // 12 mark
    /\*(?=[^\s*])([\s\S]*?[^\s*])\*/.source, // 13 em
    /(?<![A-Za-z0-9_])_(?=[^\s_])([\s\S]*?[^\s_])_(?![A-Za-z0-9_])/.source, // 14 em
  ].join('|'),
  'g',
);

export function inline(text, ctx = {}) {
  const codes = [];
  const protectedText = String(text ?? '').replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, c) => `\u0000${codes.push(c.replace(/^ ([\s\S]*) $/, '$1')) - 1}\u0000`);
  const plain = (s) => esc(s).replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${esc(codes[+n])}</code>`).replace(/\n/g, '<br>');
  const spans = (s) => {
    let out = '';
    let last = 0;
    const re = new RegExp(INLINE_RE.source, 'g');
    let m;
    while ((m = re.exec(s))) {
      out += plain(s.slice(last, m.index));
      last = re.lastIndex;
      if (m[2] !== undefined) out += image(m[1].replace(/\u0000\d+\u0000/g, ''), m[2], m[3], ctx);
      else if (m[5] !== undefined) out += link(spans(m[4]), m[5], m[6], ctx);
      else if (m[7] !== undefined) out += link(esc(m[7]), m[7], null, ctx);
      else if (m[8] !== undefined) out += link(esc(m[8]), m[8], null, ctx);
      else if (m[9] !== undefined || m[10] !== undefined) out += `<strong>${spans(m[9] ?? m[10])}</strong>`;
      else if (m[11] !== undefined) out += `<del>${spans(m[11])}</del>`;
      else if (m[12] !== undefined) out += `<mark>${spans(m[12])}</mark>`;
      else out += `<em>${spans(m[13] ?? m[14])}</em>`;
    }
    return out + plain(s.slice(last));
  };
  return spans(protectedText);
}

function iframe(src, title, cls = 'embed-16x9') {
  return `<div class="embed ${cls}"><iframe src="${esc(src)}" title="${esc(title || 'Embedded content')}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allow="fullscreen; picture-in-picture; encrypted-media" allowfullscreen sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"></iframe></div>`;
}

export function embedHtml(caption, url, ctx = {}) {
  const u = safeUrl(url);
  if (!u) return '';
  const cap = caption ? `<figcaption>${inline(caption, ctx)}</figcaption>` : '';
  let m;
  if (u.startsWith('media:')) return `<figure class="media">${mediaTag(u.slice(6), caption, ctx)}${cap}</figure>`;
  if ((m = u.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/)))
    return `<figure class="media">${iframe(`https://www.youtube-nocookie.com/embed/${m[1]}`, caption)}${cap}</figure>`;
  if ((m = u.match(/vimeo\.com\/(?:video\/)?(\d+)/))) return `<figure class="media">${iframe(`https://player.vimeo.com/video/${m[1]}`, caption)}${cap}</figure>`;
  if ((m = u.match(/loom\.com\/(?:share|embed)\/([a-f0-9]+)/))) return `<figure class="media">${iframe(`https://www.loom.com/embed/${m[1]}`, caption)}${cap}</figure>`;
  if ((m = u.match(/^https:\/\/docs\.google\.com\/(document|presentation|spreadsheets|forms)\/d\/([\w-]+)/)))
    return `<figure class="media">${iframe(`https://docs.google.com/${m[1]}/d/${m[2]}/preview`, caption, 'embed-doc')}${cap}</figure>`;
  if ((m = u.match(/^https:\/\/drive\.google\.com\/file\/d\/([\w-]+)/)))
    return `<figure class="media">${iframe(`https://drive.google.com/file/d/${m[1]}/preview`, caption, 'embed-doc')}${cap}</figure>`;
  const path = u.split(/[?#]/)[0].toLowerCase();
  if (/\.(mp4|webm|m4v|mov)$/.test(path)) return `<figure class="media"><video controls preload="metadata" playsinline src="${esc(u)}"></video>${cap}</figure>`;
  if (/\.(mp3|m4a|ogg|wav|aac)$/.test(path)) return `<figure class="media"><audio controls preload="metadata" src="${esc(u)}"></audio>${cap}</figure>`;
  if (/\.(jpe?g|png|gif|webp|avif)$/.test(path)) return `<figure class="media">${image(caption, u, null, ctx)}${cap}</figure>`;
  let host = '';
  try {
    host = new URL(u).hostname.replace(/^www\./, '');
  } catch {}
  return `<a class="link-card" href="${esc(u)}" target="_blank" rel="noopener noreferrer nofollow">${ICON_LINK}<span>${esc(caption || host || u)}</span><small>${esc(host)}${/\.pdf$/.test(path) ? ' · PDF' : ''}</small></a>`;
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}>/;
const EMBED_RE = /^\s*@\[([^\]]*)\]\(([^)\s]+)\)\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const IMG_ONLY_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g;

const indentOf = (l) => l.match(/^\s*/)[0].replace(/\t/g, '    ').length;
const isTableStart = (l, next) => l.includes('|') && next !== undefined && next.includes('|') && TABLE_SEP_RE.test(next);
const startsBlock = (l, next) =>
  FENCE_RE.test(l) || HEADING_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l) || EMBED_RE.test(l) || LIST_RE.test(l) || isTableStart(l, next);

function cells(row) {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function list(lines, i, ctx) {
  const first = lines[i].match(LIST_RE);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const contentIndent = base + first[2].length + 1;
  const items = [];
  let cur = null;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const nl = lines[j];
      if (nl !== undefined && (indentOf(nl) > base || (LIST_RE.test(nl) && indentOf(nl) === base))) {
        cur?.lines.push('');
        i++;
        continue;
      }
      break;
    }
    const m = l.match(LIST_RE);
    if (m && indentOf(l) === base) {
      cur = { lines: [m[3]] };
      items.push(cur);
    } else if (indentOf(l) > base && cur) {
      cur.lines.push(l.replace(new RegExp(`^ {0,${Math.max(contentIndent, 2)}}`), ''));
    } else if (cur && !startsBlock(l, lines[i + 1]) && cur.lines[cur.lines.length - 1] !== '') {
      cur.lines.push(l);
    } else break;
    i++;
  }
  const lis = items.map(({ lines: ls }) => {
    let head = ls[0];
    let task = '';
    const t = head.match(/^\[([ xX])\]\s+(.*)$/);
    if (t) {
      task = `<input type="checkbox" disabled${t[1] !== ' ' ? ' checked' : ''}> `;
      head = t[2];
    }
    const rest = ls.slice(1);
    const blocky = rest.some((r) => r === '' || startsBlock(r));
    if (!blocky) return `<li${task ? ' class="task"' : ''}>${task}${inline([head, ...rest].join('\n'), ctx)}</li>`;
    const firstBlock = rest.findIndex((r) => r === '' || startsBlock(r));
    const para = [head, ...rest.slice(0, firstBlock)].join('\n');
    return `<li${task ? ' class="task"' : ''}>${task}${inline(para, ctx)}${blocks(rest.slice(firstBlock), ctx)}</li>`;
  });
  const start = ordered && parseInt(first[2], 10) !== 1 ? ` start="${parseInt(first[2], 10)}"` : '';
  return { html: ordered ? `<ol${start}>${lis.join('')}</ol>` : `<ul>${lis.join('')}</ul>`, next: i };
}

function paragraph(text, ctx) {
  const imgs = [...text.matchAll(IMG_ONLY_RE)];
  if (imgs.length && !text.replace(IMG_ONLY_RE, '').trim()) {
    const figs = imgs.map((m) => `<figure>${image(m[1], m[2], m[3], ctx)}${m[1] ? `<figcaption>${esc(m[1])}</figcaption>` : ''}</figure>`);
    return imgs.length === 1 ? figs[0].replace('<figure>', '<figure class="media">') : `<div class="gallery g${Math.min(imgs.length, 4)}">${figs.join('')}</div>`;
  }
  return `<p>${inline(text, ctx)}</p>`;
}

function blocks(lines, ctx) {
  let out = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m;
    if ((m = line.match(FENCE_RE))) {
      const fence = m[1];
      const buf = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${fence[0]}{${fence.length},}\\s*$`).test(lines[i])) buf.push(lines[i++]);
      i++;
      out += `<pre${m[2] ? ` data-lang="${esc(m[2])}"` : ''}><code>${esc(buf.join('\n'))}</code></pre>`;
      continue;
    }
    if ((m = line.match(HEADING_RE))) {
      const lvl = Math.min(6, m[1].length + 1);
      const html = inline(m[2], ctx);
      out += `<h${lvl} id="h-${slug(html)}">${html}</h${lvl}>`;
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      out += '<hr>';
      i++;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const buf = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) buf.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      const cm = buf[0]?.match(/^\[!(note|tip|important|warning|caution|lesson|quote)\]\s*(.*)$/i);
      if (cm) {
        const kind = cm[1].toLowerCase();
        buf.shift();
        out += `<aside class="callout callout-${kind}"><div class="callout-label">${esc(cm[2] || kind)}</div>${blocks(buf, ctx)}</aside>`;
      } else out += `<blockquote>${blocks(buf, ctx)}</blockquote>`;
      continue;
    }
    if ((m = line.match(EMBED_RE))) {
      out += embedHtml(m[1], m[2], ctx);
      i++;
      continue;
    }
    if (LIST_RE.test(line)) {
      const r = list(lines, i, ctx);
      out += r.html;
      i = r.next;
      continue;
    }
    if (isTableStart(line, lines[i + 1])) {
      const head = cells(line);
      const aligns = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      const td = (tag, c, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inline(c, ctx)}</${tag}>`;
      out += `<div class="table-wrap"><table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr>${head.map((_, k) => td('td', r[k] ?? '', k)).join('')}</tr>`)
        .join('')}</tbody></table></div>`;
      continue;
    }
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) buf.push(lines[i++]);
    out += paragraph(buf.join('\n'), ctx);
  }
  return out;
}

export function renderMarkdown(md, ctx = {}) {
  return blocks(String(md ?? '').replace(/\r\n?/g, '\n').split('\n'), ctx);
}

export function plainText(md) {
  return String(md ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*@\[([^\]]*)\]\([^)]*\)/gm, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\[!(\w+)\]/g, '')
    .replace(/[*_~=`|#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function mediaRefs(text) {
  return [...new Set([...String(text ?? '').matchAll(/media:([a-z0-9]{4,40})/gi)].map((m) => m[1]))];
}
