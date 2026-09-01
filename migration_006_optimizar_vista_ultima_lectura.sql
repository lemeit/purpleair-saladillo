-- Migración: optimiza v_ultima_lectura para no escanear toda la tabla
-- lecturas en cada consulta.
--
-- Causa raíz del agotamiento de la cuota gratuita de D1 (5.000.000
-- rows_read/día, alcanzada el 2026-09-01): la vista original resolvía
-- "última lectura por sensor" con un NOT EXISTS correlacionado que recorre
-- TODA la tabla lecturas como relación externa, en CADA llamada a
-- /api/ultimas. El dashboard llama a /api/ultimas al cargar y cada 5
-- minutos por cada pestaña abierta (ver index.html, setInterval(loadSensors,
-- 5*60*1000)), así que cada lectura acumulada en la tabla se volvía a leer
-- una y otra vez, para siempre — el costo crecía sin techo a medida que
-- pasaban los meses de ingesta.
--
-- Como migration_003_dedupe_lecturas.sql ya garantiza como máximo una fila
-- por (sensor_index, timestamp) -- índice UNIQUE
-- idx_lecturas_sensor_ts_unique -- ya no puede haber empates de timestamp
-- para un mismo sensor, así que un simple GROUP BY sensor_index /
-- MAX(timestamp) alcanza (no hace falta desempatar por id como hacía el
-- NOT EXISTS original). Con el índice existente idx_lecturas_sensor_ts
-- (sensor_index, timestamp), SQLite resuelve ese MAX() por grupo con un
-- "index skip-scan": lee aproximadamente una fila por sensor, no la tabla
-- entera.
--
-- Se corre a mano contra D1 (no es automática en cada deploy):
--   cd worker
--   wrangler d1 execute purpleair-saladillo --remote --file=../migration_006_optimizar_vista_ultima_lectura.sql

DROP VIEW IF EXISTS v_ultima_lectura;

CREATE VIEW v_ultima_lectura AS
SELECT l.*
FROM lecturas l
JOIN (
    SELECT sensor_index, MAX(timestamp) AS ts
    FROM lecturas
    GROUP BY sensor_index
) m ON m.sensor_index = l.sensor_index AND m.ts = l.timestamp;
