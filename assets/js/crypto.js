// Shared crypto primitives. Runs unchanged in browsers, Node >= 20 and Cloudflare Workers.
const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export const KDF_ITERATIONS = 600_000;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const utf8 = (s) => te.encode(s);
export const fromUtf8 = (b) => td.decode(b);

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function randomId(len = 12) {
  let s = '';
  for (const x of randomBytes(len)) s += B32[x & 31];
  return s;
}

export function b64encode(bytes) {
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const b64urlEncode = (bytes) => b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return b64decode(s);
}

export const newRawKey = () => b64encode(randomBytes(32));

export async function importAesKey(raw) {
  if (typeof raw === 'string') raw = b64decode(raw);
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Output layout: 12-byte IV || ciphertext+tag. AAD binds ciphertext to its logical slot (prevents swapping files).
export async function encryptBytes(key, data, aad) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad) }, key, data));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

export async function decryptBytes(key, data, aad) {
  data = data instanceof Uint8Array ? data : new Uint8Array(data);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: data.subarray(0, 12), additionalData: utf8(aad) }, key, data.subarray(12));
  return new Uint8Array(pt);
}

export async function sealJSON(key, obj, aad) {
  const blob = await encryptBytes(key, utf8(JSON.stringify(obj)), aad);
  return { v: 1, alg: 'A256GCM', ct: b64encode(blob) };
}

export async function openJSON(key, env, aad) {
  if (!env || env.alg !== 'A256GCM') throw new Error('Not an encrypted envelope');
  return JSON.parse(fromUtf8(await decryptBytes(key, b64decode(env.ct), aad)));
}

async function deriveKek(passphrase, salt, iterations) {
  const base = await subtle.importKey('raw', utf8(String(passphrase).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function createKeyring(passphrase, secrets, iterations = KDF_ITERATIONS) {
  const salt = randomBytes(16);
  const kek = await deriveKek(passphrase, salt, iterations);
  const sealed = await sealJSON(kek, secrets, 'keyring');
  return { v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: b64encode(salt) }, alg: sealed.alg, ct: sealed.ct };
}

export async function openKeyring(keyring, passphrase) {
  if (!keyring?.kdf) return null;
  const kek = await deriveKek(passphrase, b64decode(keyring.kdf.salt), keyring.kdf.iterations);
  try {
    return await openJSON(kek, keyring, 'keyring');
  } catch {
    return null;
  }
}

export async function sha256Hex(input) {
  const d = new Uint8Array(await subtle.digest('SHA-256', typeof input === 'string' ? utf8(input) : input));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const hmacKey = (secret) => subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export async function signToken(secret, payload) {
  const p = b64urlEncode(utf8(JSON.stringify(payload)));
  const sig = new Uint8Array(await subtle.sign('HMAC', await hmacKey(secret), utf8(p)));
  return `${p}.${b64urlEncode(sig)}`;
}

export async function verifyToken(secret, token) {
  const [p, s, extra] = String(token || '').split('.');
  if (!p || !s || extra !== undefined) return null;
  try {
    const ok = await subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(s), utf8(p));
    return ok ? JSON.parse(fromUtf8(b64urlDecode(p))) : null;
  } catch {
    return null;
  }
}

export function timingSafeEqual(a, b) {
  a = String(a ?? '');
  b = String(b ?? '');
  let r = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return r === 0;
}

// Access codes use Crockford base32; ambiguous characters are folded so "O0" / "I1L" typos still match.
export function normalizeCode(s) {
  return String(s || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

export function generateCode(groups = 4) {
  const b = randomBytes(groups * 4);
  let s = '';
  for (let i = 0; i < b.length; i++) {
    if (i && i % 4 === 0) s += '-';
    s += CROCKFORD[b[i] & 31];
  }
  return s;
}

export const hashCode = (code) => sha256Hex(`canvito-code:${normalizeCode(code)}`);
