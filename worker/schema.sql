-- Worker database (Cloudflare D1): access codes + the private visitor counter. Apply (safe to re-run) with:
--   cd worker; npx wrangler d1 execute canvito-visits --remote --file schema.sql

-- Access codes. Only a SHA-256 hash of each code is stored; the code itself is shown once when created.
CREATE TABLE IF NOT EXISTS codes (
  hash TEXT PRIMARY KEY,             -- sha-256 of the normalized code
  id TEXT NOT NULL UNIQUE,           -- first 12 hex characters of the hash (shown in lists)
  label TEXT NOT NULL,               -- who it's for
  type TEXT NOT NULL,                -- once | timed | permanent
  created_at TEXT NOT NULL,          -- ISO time
  expires_at INTEGER,                -- milliseconds since epoch, or NULL
  max_uses INTEGER NOT NULL DEFAULT 0,  -- 0 = unlimited
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  revoked_at TEXT                    -- set when revoked
);

-- Private visitor counter.
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,               -- milliseconds since epoch (UTC)
  vid TEXT NOT NULL,                 -- anonymous random id stored in the visitor's browser
  ip_hash TEXT NOT NULL,             -- keyed hash of the IP (raw IPs are never stored)
  path TEXT NOT NULL,                -- page, e.g. #/journal or #/p/<id>
  referrer TEXT,                     -- external site the visitor came from (host only)
  country TEXT,
  region TEXT,
  city TEXT,
  device TEXT,                       -- desktop | mobile | tablet
  browser TEXT,
  os TEXT,
  guest TEXT,                        -- access-code label when the visitor was unlocked
  new_visitor INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_visits_ts ON visits (ts);
CREATE INDEX IF NOT EXISTS idx_visits_vid ON visits (vid);
CREATE INDEX IF NOT EXISTS idx_visits_ip_ts ON visits (ip_hash, ts);
