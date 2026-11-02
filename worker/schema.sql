-- Private visitor counter (Cloudflare D1). Apply with:
--   cd worker; npx wrangler d1 execute canvito-visits --remote --file schema.sql
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
