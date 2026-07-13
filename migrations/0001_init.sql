-- Model B schema: finished door images + equipment overlays.
CREATE TABLE IF NOT EXISTS models (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  image_key       TEXT NOT NULL,          -- R2 key, e.g. models/1.png (finished door)
  inner_image_key TEXT,                   -- optional inside-view image
  price           REAL NOT NULL DEFAULT 0,
  width           INTEGER NOT NULL,       -- canvas px (overlay coords are fractions of this)
  height          INTEGER NOT NULL,
  is_shown        INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,        -- handrail, spy, hinges, houseNumbers, ...
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS equipment (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name        TEXT NOT NULL,
  image_key   TEXT NOT NULL,              -- R2 key, e.g. equipment/5.png (overlay PNG)
  price       REAL NOT NULL DEFAULT 0,
  anchor_x    REAL NOT NULL DEFAULT 0,    -- 0..1 fraction of model width
  anchor_y    REAL NOT NULL DEFAULT 0,    -- 0..1 fraction of model height
  is_shown    INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user'   -- admin | user
);

CREATE INDEX IF NOT EXISTS idx_equipment_category ON equipment(category_id);
