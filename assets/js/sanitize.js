// Removes metadata (GPS location, camera, timestamps, embedded thumbnails, text notes) from photos.
// Lossless: only metadata blocks are dropped, image data is copied byte for byte.
// Used by the browser Studio and the CLI through Vault.writeAsset.
const enc = new TextEncoder();
const ascii = (b) => String.fromCharCode(...b);
const startsWith = (b, s) => b.length >= s.length && ascii(b.subarray(0, s.length)) === s;

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function stripMetadata(bytes, ext) {
  if (ext === 'jpg') return stripJpeg(bytes);
  if (ext === 'png') return stripPng(bytes);
  if (ext === 'webp') return stripWebp(bytes);
  return bytes;
}

// ---------- JPEG ----------
const bad = () => new Error('This JPEG could not be cleaned of metadata. Re-save it (e.g. export as JPEG) and try again.');

// Returns the EXIF orientation (1–8), or 0 if the block has none.
function exifOrientation(payload) {
  try {
    if (!startsWith(payload, 'Exif\0\0')) return 0;
    const t = payload.subarray(6);
    const le = t[0] === 0x49;
    const u16 = (o) => (le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]);
    const u32 = (o) => (le ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16)) + t[o + 3] * 2 ** 24 : t[o] * 2 ** 24 + ((t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3]));
    const ifd = u32(4);
    const n = u16(ifd);
    for (let k = 0; k < n && ifd + 2 + k * 12 + 12 <= t.length; k++) {
      const e = ifd + 2 + k * 12;
      if (u16(e) === 0x0112) {
        const v = u16(e + 8);
        return v >= 1 && v <= 8 ? v : 0;
      }
    }
  } catch {}
  return 0;
}

// Minimal EXIF block that carries only the orientation, so rotated phone photos still display upright.
function orientationSegment(o) {
  return new Uint8Array([
    0xff, 0xe1, 0x00, 0x22, ...enc.encode('Exif\0\0'), ...enc.encode('MM'), 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, o, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
}

function stripJpeg(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw bad();
  const out = [b.subarray(0, 2)];
  const app0 = [];
  const apps = [];
  let header = true;
  let orientation = 1;
  let i = 2;
  let ended = false;
  while (i < b.length - 1) {
    if (b[i] !== 0xff) throw bad();
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd9) {
      out.push(b.subarray(i, i + 2)); // anything appended after the end marker (e.g. motion-photo video) is dropped
      ended = true;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > b.length) throw bad();
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) throw bad();
    const seg = b.subarray(i, i + 2 + len);
    const payload = b.subarray(i + 4, i + 2 + len);
    const isApp = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (isApp) {
      if (marker === 0xe1) orientation = exifOrientation(payload) || orientation;
      else if (marker === 0xe0 && startsWith(payload, 'JFIF\0')) (header ? app0 : out).push(seg);
      else if ((marker === 0xe2 && startsWith(payload, 'ICC_PROFILE\0')) || (marker === 0xee && startsWith(payload, 'Adobe'))) (header ? apps : out).push(seg);
    } else {
      if (header) {
        out.push(...app0);
        if (orientation !== 1) out.push(orientationSegment(orientation));
        out.push(...apps);
        header = false;
      }
      out.push(seg);
    }
    i += 2 + len;
    if (marker === 0xda) {
      // Entropy-coded scan data runs until the next marker that isn't a stuffed 0xFF00 or a restart marker.
      let j = i;
      while (j < b.length - 1 && !(b[j] === 0xff && b[j + 1] !== 0x00 && !(b[j + 1] >= 0xd0 && b[j + 1] <= 0xd7))) j++;
      if (j >= b.length - 1) {
        out.push(b.subarray(i));
        ended = true;
        break;
      }
      out.push(b.subarray(i, j));
      i = j;
    }
  }
  if (!ended || header) throw bad();
  return concat(out);
}

// ---------- PNG ----------
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function stripPng(b) {
  if (!PNG_SIG.every((v, k) => b[k] === v)) throw new Error('This PNG could not be read.');
  const out = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b[i] * 2 ** 24 + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
    const type = ascii(b.subarray(i + 4, i + 8));
    const end = i + 12 + len;
    if (end > b.length) throw new Error('This PNG could not be read.');
    if (!PNG_DROP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return concat(out);
}

// ---------- WebP ----------
function stripWebp(b) {
  if (!startsWith(b, 'RIFF') || ascii(b.subarray(8, 12)) !== 'WEBP') throw new Error('This WebP could not be read.');
  const chunks = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = ascii(b.subarray(i, i + 4));
    const size = (b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16)) + b[i + 7] * 2 ** 24;
    const end = i + 8 + size + (size & 1);
    if (i + 8 + size > b.length) throw new Error('This WebP could not be read.');
    if (type !== 'EXIF' && type !== 'XMP ') {
      const c = b.slice(i, Math.min(end, b.length));
      if (type === 'VP8X' && size > 0) c[8] &= ~0x0c; // clear the "has EXIF" and "has XMP" flags
      chunks.push(c);
    }
    i = end;
  }
  const body = concat(chunks);
  const head = new Uint8Array(12);
  head.set(enc.encode('RIFF'));
  const total = body.length + 4;
  head.set([total & 0xff, (total >> 8) & 0xff, (total >> 16) & 0xff, (total >>> 24) & 0xff], 4);
  head.set(enc.encode('WEBP'), 8);
  return concat([head, body]);
}
