-- Registro mínimo de accesos a la API (aq.lemeit.ar), para poder ver quién
-- (país, ruta, user-agent) usa el portal sin depender de un panel externo.
-- Se llena desde el Worker vía ctx.waitUntil() en cada GET público, así no
-- demora la respuesta real. Ver /api/admin/visitas y /api/admin/resumen en
-- worker/src/index.js (protegidos por el secret ADMIN_KEY).
CREATE TABLE IF NOT EXISTS visitas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  path TEXT,
  pais TEXT,
  referrer TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_visitas_ts ON visitas(ts);
