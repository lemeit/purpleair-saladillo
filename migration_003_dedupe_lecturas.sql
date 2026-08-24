-- Migración: elimina las lecturas duplicadas que se acumulan cuando un
-- sensor se desconecta, y evita que se vuelvan a generar.
--
-- Causa raíz del bug de tarjetas duplicadas/triplicadas: cuando un sensor
-- pierde conexión, la API de PurpleAir sigue devolviendo su último
-- "last_seen" (congelado, no cambia). Como ingest_purpleair.py insertaba
-- sin chequear si esa lectura ya existía, cada corrida del cron (cada 15
-- min) agregaba una fila nueva con el MISMO timestamp para ese sensor.
-- v_ultima_lectura hacía MAX(timestamp) + JOIN, así que si dos o más filas
-- quedaban empatadas en el timestamp máximo, la vista devolvía TODAS esas
-- filas (no una sola) — y el dashboard las pintaba como tarjetas repetidas.
--
-- Esta migración:
--   1) Borra los duplicados ya acumulados en la base.
--   2) Agrega un índice UNIQUE que impide insertar el mismo
--      (sensor_index, timestamp) dos veces.
--   3) Redefine v_ultima_lectura para que, aunque alguna vez vuelva a haber
--      un empate de timestamp, devuelva como máximo una fila por sensor
--      (desempatando por el id más alto).
--
-- Se corre a mano contra D1 (no es automática en cada deploy):
--   wrangler d1 execute <NOMBRE_DB> --remote --file=migration_003_dedupe_lecturas.sql

-- 1) Deja solo la fila de menor id por cada (sensor_index, timestamp) repetido.
DELETE FROM lecturas
WHERE id NOT IN (
    SELECT MIN(id)
    FROM lecturas
    GROUP BY sensor_index, timestamp
);

-- 2) A partir de ahora, un INSERT con el mismo (sensor_index, timestamp)
--    falla (o se ignora, ver ingest_purpleair.py) en vez de crear una fila más.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lecturas_sensor_ts_unique
ON lecturas (sensor_index, timestamp);

-- 3) Vista robusta: nunca devuelve más de una fila por sensor, incluso si
--    hubiera un empate de timestamp (desempata por el id más alto).
DROP VIEW IF EXISTS v_ultima_lectura;
CREATE VIEW v_ultima_lectura AS
SELECT l.*
FROM lecturas l
WHERE NOT EXISTS (
    SELECT 1 FROM lecturas l2
    WHERE l2.sensor_index = l.sensor_index
      AND (l2.timestamp > l.timestamp
           OR (l2.timestamp = l.timestamp AND l2.id > l.id))
);
