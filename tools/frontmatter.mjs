// Front-matter Markdown used by the CLI (`put`, `show --out`).
export const FM_KEYS = ['id', 'title', 'date', 'kind', 'tier', 'tags', 'summary', 'cover', 'location'];

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
  const lines = FM_KEYS.filter((k) => post[k] !== undefined && post[k] !== '' && !(Array.isArray(post[k]) && !post[k].length)).map((k) =>
    k === 'tags' ? `tags: [${post.tags.join(', ')}]` : `${k}: ${yamlStr(String(post[k]))}`,
  );
  return `---\n${lines.join('\n')}\n---\n${post.body.startsWith('\n') ? '' : '\n'}${post.body}`;
}
