-- Eventos de varios días (una fila por día, unidas por `series`) y días completos sin horario.
-- Un día con all_day=1 ocupa la jornada entera: ese día no se colocan tareas.
-- tbc=1: "horario por confirmar" (el bot lo pregunta unos días antes).
ALTER TABLE items ADD COLUMN series TEXT;
ALTER TABLE items ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN tbc INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_items_series ON items(series);
