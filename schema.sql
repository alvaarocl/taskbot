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
  url TEXT,
  series TEXT,                               -- eventos de varios días: una fila por día con la misma serie
  all_day INTEGER NOT NULL DEFAULT 0,        -- día completo (ocupa la jornada entera)
  tbc INTEGER NOT NULL DEFAULT 0             -- horario por confirmar
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
CREATE INDEX IF NOT EXISTS idx_items_series ON items(series);


CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,                       -- credentialId en base64url
  public_key TEXT NOT NULL,                  -- JWK
  alg INTEGER NOT NULL,                      -- -7 = ES256, -257 = RS256
  sign_count INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,               -- SHA-256 del valor de la cookie (nunca en claro)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  hash TEXT PRIMARY KEY,                     -- SHA-256 del challenge o del enlace de recuperación
  kind TEXT NOT NULL,                        -- challenge | recovery
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS auth_attempts (
  key TEXT PRIMARY KEY,                      -- hash de la IP + ventana
  count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL
);

-- Sin email: solo lo necesario para verlo en el panel. Se borra a los 90 días.
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,                       -- "msg:<uuid>" | "book:<id del evento de Google>"
  kind TEXT NOT NULL,                        -- mensaje | reunion
  name TEXT,
  topic TEXT,
  message TEXT,
  start_at TEXT,                             -- ISO UTC (reuniones)
  end_at TEXT,
  duration INTEGER,
  meet TEXT,
  status TEXT NOT NULL DEFAULT 'nuevo',      -- nuevo | visto | cancelada
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inbox_created ON inbox(created_at);

CREATE TABLE IF NOT EXISTS weekly (
  week TEXT PRIMARY KEY,                     -- YYYY-Www (ISO)
  data TEXT NOT NULL,                        -- JSON con commits, tareas y clases
  draft TEXT,                                -- borrador del post build in public
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Migración 2026-10-06 (BD ya creada):
--   npx wrangler d1 execute taskbot --remote --file=migrations/2026-10-06-agenda.sql
--   npx wrangler d1 execute taskbot --remote --file=migrations/2026-10-06-aulaglobal.sql
--   npx wrangler d1 execute taskbot --remote --file=migrations/2026-10-07-due-at.sql
--   npx wrangler d1 execute taskbot --remote --file=migrations/2026-10-14-panel.sql
--   npx wrangler d1 execute taskbot --remote --file=migrations/2026-10-14-series.sql
