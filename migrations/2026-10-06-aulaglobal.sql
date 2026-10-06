-- Aula Global: tareas que vienen de entregas/cuestionarios (source único) y su enlace.
ALTER TABLE items ADD COLUMN source TEXT;
ALTER TABLE items ADD COLUMN url TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_source ON items(source);
