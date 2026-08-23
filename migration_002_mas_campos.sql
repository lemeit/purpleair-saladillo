-- Migración: agrega canal A/B para PM1.0 y PM10.0 (ya teníamos pm2.5_a/b desde
-- la migración 001) y el campo de VOC (campo "voc" de la API de PurpleAir).
--
-- Nota sobre voc: ese campo solo lo reportan sensores PurpleAir Flex, Zen,
-- Touch, o un Classic/Classic-SD con el sensor BME688 (upgrade de hardware).
-- Los PA-II / PA-II-SD estándar traen un BME280, que NO mide VOC — para esos
-- sensores esta columna va a quedar siempre en NULL, no es un bug.
ALTER TABLE lecturas ADD COLUMN pm1_0_a REAL;
ALTER TABLE lecturas ADD COLUMN pm1_0_b REAL;
ALTER TABLE lecturas ADD COLUMN pm10_0_a REAL;
ALTER TABLE lecturas ADD COLUMN pm10_0_b REAL;
ALTER TABLE lecturas ADD COLUMN voc REAL;
