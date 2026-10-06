-- Esquema D1 para taskbot. Aplicar con:
--   npx wrangler d1 execute taskbot --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'tarea',        -- tarea | evento | nota | material
  status TEXT NOT NULL DEFAULT 'pendiente',  -- pendiente | hecha
  text TEXT,
  category TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',   -- urgente | normal | algun_dia
  due_date TEXT,                             -- YYYY-MM-DD
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_at TEXT,
  reminded_at TEXT,
  start_at TEXT,                             -- YYYY-MM-DDTHH:MM, hora de Madrid (evento, o bloque planificado de una tarea)
  end_at TEXT,
  duration_min INTEGER,                      -- duración del evento o estimación de la tarea
  location TEXT,
  due_at TEXT,                               -- YYYY-MM-DDTHH:MM, hora exacta de la fecha límite (Aula Global)
  source TEXT,                               -- origen externo, p. ej. "ag:assign:123" (Aula Global)
  url TEXT
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
CREATE INDEX IF NOT EXISTS idx_items_start ON items(start_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_source ON items(source);

-- Migración 2026-10-06 (BD ya creada):
--   npx wrangler d1 execute taskbot --remote --file=migrations/2026-10-06-agenda.sql
--   npx wrangler d1 execute taskbot --remote --file=migrations/2026-10-06-aulaglobal.sql
--   npx wrangler d1 execute taskbot --remote --file=migrations/2026-10-07-due-at.sql
