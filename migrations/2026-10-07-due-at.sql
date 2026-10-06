-- Hora exacta de la fecha límite (Aula Global), para los recordatorios de 24 h y 3 h.
ALTER TABLE items ADD COLUMN due_at TEXT;
