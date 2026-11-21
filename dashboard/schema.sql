CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at REAL NOT NULL,
  message TEXT NOT NULL,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS events_recent ON events(at DESC);
