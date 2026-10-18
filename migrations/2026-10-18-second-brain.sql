-- Aplicar antes del nuevo Worker. Solo añade tablas; no altera tus tareas ni calendarios.
CREATE TABLE IF NOT EXISTS runtime_jobs (
 id TEXT PRIMARY KEY, operation TEXT NOT NULL, payload TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', result TEXT, lease TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL, completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runtime_jobs_claim ON runtime_jobs(status,expires_at,lease_until);
CREATE TABLE IF NOT EXISTS sync_state (
 source TEXT PRIMARY KEY, success_at TEXT, attempted_at TEXT NOT NULL, error TEXT
);
CREATE TABLE IF NOT EXISTS processed_updates (
 id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_state (
 key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
);
