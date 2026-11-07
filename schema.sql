-- One row per voter. user_id is a random id kept in a signed cookie. No names, emails or IPs are stored.
CREATE TABLE IF NOT EXISTS votes (
  user_id    TEXT PRIMARY KEY,
  platform   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Running totals so reading the standings never scans the votes table.
-- The hourly cron recounts from votes to correct any drift.
CREATE TABLE IF NOT EXISTS tallies (
  platform TEXT PRIMARY KEY,
  count    INTEGER NOT NULL DEFAULT 0
);

-- Small key/value store. "history" holds hourly snapshots for the last 15 days as one JSON row.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- How many new voters each network added today. k is an HMAC of IP + day, so raw IPs are never stored.
-- The hourly cron deletes old days.
CREATE TABLE IF NOT EXISTS ip_daily (
  k   TEXT PRIMARY KEY,
  day INTEGER NOT NULL,
  n   INTEGER NOT NULL DEFAULT 0
);
