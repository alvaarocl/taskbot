-- Agenda: eventos con hora y bloques de tareas planificados en huecos libres.
ALTER TABLE items ADD COLUMN start_at TEXT;
ALTER TABLE items ADD COLUMN end_at TEXT;
ALTER TABLE items ADD COLUMN duration_min INTEGER;
ALTER TABLE items ADD COLUMN location TEXT;
CREATE INDEX IF NOT EXISTS idx_items_start ON items(start_at);
