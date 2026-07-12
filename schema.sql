-- Esquema D1 para taskbot. Aplicar con:
--   npx wrangler d1 execute taskbot --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'tarea',        -- tarea | nota | material
  status TEXT NOT NULL DEFAULT 'pendiente',  -- pendiente | hecha
  text TEXT,
  category TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',   -- urgente | normal | algun_dia
  due_date TEXT,                             -- YYYY-MM-DD
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_at TEXT,
  reminded_at TEXT
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  mime TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_status ON items(status, kind);
CREATE INDEX IF NOT EXISTS idx_att_item ON attachments(item_id);
