-- Panel web: passkeys, sesiones, enlaces de recuperación,
-- mensajes y reservas de tu web (opcional, ver src/inbox.js) y el resumen semanal.

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
