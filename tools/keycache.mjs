// Cached decrypted keys for the CLI (~/.canvito/keys-*.json).
// On Windows the file is encrypted with DPAPI (tied to your Windows login), so a copied file or backup is useless
// on another account or computer. Commands still run without prompts. Older plaintext caches are upgraded on read.
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

function dpapi(op, b64) {
  const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${op}($b, $null, 'CurrentUser'))`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: b64, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !r.stdout.trim()) throw new Error(`Could not ${op.toLowerCase()} the key cache with Windows DPAPI. Run "logout" then "login".`);
  return r.stdout.trim();
}

export async function writeKeyCache(file, secrets) {
  const json = JSON.stringify(secrets);
  const body = isWindows ? JSON.stringify({ v: 1, dpapi: dpapi('Protect', Buffer.from(json).toString('base64')) }) : json;
  await fs.writeFile(file, body, { mode: 0o600 });
}

export async function readKeyCache(file) {
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  if (data.dpapi) return JSON.parse(Buffer.from(dpapi('Unprotect', data.dpapi), 'base64').toString('utf8'));
  if (isWindows) await writeKeyCache(file, data);
  return data;
}
