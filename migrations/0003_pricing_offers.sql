-- Markups (per-user + a default admin markup), inquiries, saved printed offers.
CREATE TABLE IF NOT EXISTS markups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  markup_label TEXT NOT NULL DEFAULT 'default',
  markup_value REAL NOT NULL DEFAULT 0,   -- percent
  is_default   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_markups_user ON markups(user_id);

CREATE TABLE IF NOT EXISTS inquiries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT,
  email      TEXT,
  phone      TEXT,
  message    TEXT,
  config     TEXT,   -- JSON snapshot of the door config
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS printed_contents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  content    TEXT NOT NULL,   -- the printable offer HTML
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_printed_user ON printed_contents(user_id);

-- default admin markup (0% until set in admin)
INSERT INTO markups (user_id, markup_label, markup_value, is_default) VALUES (1, 'default', 0, 1);
