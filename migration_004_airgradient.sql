-- Suma soporte para sensores AirGradient en las mismas tablas sensores/lecturas
-- (además de PurpleAir), para que el dashboard los muestre unificados en vez
-- de necesitar un portal aparte.
--
-- sensor_index sigue siendo INTEGER PRIMARY KEY y los sensores PurpleAir
-- existentes no se tocan (conservan su sensor_index real). A los sensores
-- AirGradient el Worker les asigna automáticamente un ID sintético en el
-- rango 900000+ (900001, 900002, ...) la primera vez que los ve, para que
-- nunca choquen con un sensor_index real de PurpleAir. El serial real de
-- AirGradient (ej. "airgradient_xxxxxxxx") queda guardado en
-- serial_externo, que es lo que el Worker usa para reconocer un sensor ya
-- registrado en corridas siguientes. Ver worker/src/index.js → ingestAirGradient().
--
-- Se corre a mano contra D1 (no es automática en cada deploy):
--   wrangler d1 execute purpleair-saladillo --remote --file=migration_004_airgradient.sql

ALTER TABLE sensores ADD COLUMN proveedor TEXT NOT NULL DEFAULT 'purpleair';
ALTER TABLE sensores ADD COLUMN serial_externo TEXT;

-- CO2 en ppm — no existía porque PurpleAir no lo mide, solo AirGradient (BME688 no da CO2 real).
ALTER TABLE lecturas ADD COLUMN co2 REAL;
