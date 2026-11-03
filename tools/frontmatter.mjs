// Front-matter Markdown used by the CLI (`put`, `show --out`).
// Vietnamese version: `title_vi` / `summary_vi` fields, and the Vietnamese body after a line `<!-- vi -->`.
export const FM_KEYS = ['id', 'title', 'title_vi', 'date', 'kind', 'tier', 'tags', 'summary', 'summary_vi', 'cover', 'location'];
const VI_MARK = /^[ \t]*<!--\s*vi\s*-->[ \t]*\r?$/m;

// One YAML-ish scalar: quoted values keep everything inside the quotes; otherwise a " # comment" is dropped.
function scalar(raw) {
  const v = raw.trim();
  if (v[0] === '"') {
    for (let i = 1; i < v.length; i++) {
      if (v[i] === '\\') i++;
      else if (v[i] === '"') {
        try {
          return JSON.parse(v.slice(0, i + 1));
        } catch {
          return v.slice(1, i);
        }
      }
    }
  }
  if (v[0] === "'") {
    for (let i = 1; i < v.length; i++) {
      if (v[i] === "'" && v[i + 1] === "'") i++;
      else if (v[i] === "'") return v.slice(1, i).replace(/''/g, "'");
    }
  }
  return v.replace(/(^|\s)#.*$/, '').trim();
}

export function parseFrontMatter(text) {
  const m = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+):(?:\s+(.*))?$/);
    if (!kv) continue;
    const raw = kv[2] ?? '';
    meta[kv[1]] =
      kv[1] === 'tags'
        ? scalar(raw).replace(/^\[|\]$/g, '').split(',').map((t) => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
        : scalar(raw);
  }
  return { meta, body: m[2] };
}

const yamlStr = (v) => (/^[\w][\w .,/()&+-]*$/.test(v) && !/:\s/.test(v) ? v : JSON.stringify(v));

export function toFrontMatter(post) {
  const p = { ...post, title_vi: post.vi?.title, summary_vi: post.vi?.summary };
  const lines = FM_KEYS.filter((k) => p[k] !== undefined && p[k] !== '' && !(Array.isArray(p[k]) && !p[k].length)).map((k) =>
    k === 'tags' ? `tags: [${p.tags.join(', ')}]` : `${k}: ${yamlStr(String(p[k]))}`,
  );
  const vi = post.vi?.body?.trim() ? `\n\n<!-- vi -->\n${post.vi.body.replace(/^\n+/, '')}` : '';
  const body = vi ? post.body.replace(/\s+$/, '') : post.body;
  return `---\n${lines.join('\n')}\n---\n${body.startsWith('\n') ? '' : '\n'}${body}${vi}`;
}

// Entry input from a front-matter Markdown file: { ...meta, body, vi? }.
export function entryFromText(text) {
  const { meta, body } = parseFrontMatter(text);
  const { title_vi: titleVi, summary_vi: summaryVi, ...rest } = meta;
  const [en, viBody] = body.replace(/^\r?\n/, '').split(VI_MARK);
  const input = { ...rest, body: viBody === undefined ? en : en.replace(/\s+$/, '\n') };
  if (titleVi !== undefined || summaryVi !== undefined || viBody !== undefined)
    input.vi = { title: titleVi ?? '', summary: summaryVi ?? '', body: (viBody ?? '').replace(/^\r?\n/, '') };
  return input;
}
