CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at REAL NOT NULL,
  message TEXT NOT NULL,
  outcome TEXT,
  project TEXT,
  session_url TEXT,
  session_state TEXT
);
CREATE INDEX IF NOT EXISTS events_recent ON events(at DESC);
CREATE INDEX IF NOT EXISTS events_host_sid ON events(host, session_id, at DESC);
CREATE TABLE IF NOT EXISTS watcher_health (
  id TEXT PRIMARY KEY,
  updated_at REAL NOT NULL,
  payload TEXT NOT NULL
);
