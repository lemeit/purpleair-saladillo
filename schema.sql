-- Schema para el proyecto de sensores PurpleAir de Saladillo
-- Cloudflare D1 (SQLite)

-- Metadata de cada sensor físico: dónde está instalado y su sensor_index de PurpleAir
CREATE TABLE IF NOT EXISTS sensores (
    sensor_index INTEGER PRIMARY KEY,     -- sensor_index de PurpleAir, o ID sintético 900000+ para AirGradient (ver migration_004)
    nombre TEXT NOT NULL,                 -- nombre descriptivo, ej. "PurpleAir-9f3"
    institucion TEXT,                     -- nombre de la escuela/jardín donde está instalado
    latitud REAL,
    longitud REAL,
    activo INTEGER DEFAULT 1,             -- 1 = actualmente instalado y monitoreado, 0 = de baja/en tránsito
    fecha_instalacion TEXT,               -- ISO8601, opcional
    notas TEXT,
    proveedor TEXT NOT NULL DEFAULT 'purpleair',  -- 'purpleair' | 'airgradient' | futuro 'clarity'
    serial_externo TEXT                   -- serial real del fabricante (AirGradient), para reconocer el sensor entre corridas
);

-- Serie temporal de lecturas. Una fila por consulta a la API por sensor.
CREATE TABLE IF NOT EXISTS lecturas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sensor_index INTEGER NOT NULL REFERENCES sensores(sensor_index),
    timestamp TEXT NOT NULL,              -- ISO8601 UTC, momento de la lectura reportado por PurpleAir
    pm1_0 REAL,
    pm2_5 REAL,
    pm2_5_10min REAL,
    pm2_5_60min REAL,
    pm10_0 REAL,
    pm2_5_a REAL,                         -- canal A (para overlay / detectar divergencia entre canales)
    pm2_5_b REAL,                         -- canal B
    pm1_0_a REAL,
    pm1_0_b REAL,
    pm10_0_a REAL,
    pm10_0_b REAL,
    voc REAL,                             -- campo "voc" de la API PurpleAir (BME68x): solo en PurpleAir Flex/Zen/Touch o Classic con upgrade BME688; NULL en sensores PA-II/PA-II-SD estándar
    temperatura REAL,                     -- Celsius (convertida desde Fahrenheit en ingest_purpleair.py)
    humedad REAL,
    presion REAL,
    rssi INTEGER,
    co2 REAL,                             -- ppm, solo AirGradient (ver migration_004) — NULL en filas de PurpleAir
    creado_en TEXT DEFAULT (datetime('now'))
);

-- Índices para las consultas típicas: por sensor y por rango de fecha
CREATE INDEX IF NOT EXISTS idx_lecturas_sensor_ts ON lecturas (sensor_index, timestamp);
CREATE INDEX IF NOT EXISTS idx_lecturas_ts ON lecturas (timestamp);

-- UNIQUE en (sensor_index, timestamp): evita filas duplicadas cuando un
-- sensor desconectado repite el mismo "last_seen" en corridas sucesivas del
-- cron. Ver migration_003_dedupe_lecturas.sql para bases ya existentes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lecturas_sensor_ts_unique ON lecturas (sensor_index, timestamp);

-- Vista de última lectura por sensor, útil para el dashboard "estado actual".
-- NOT EXISTS en vez de MAX()+JOIN a propósito: garantiza como máximo UNA
-- fila por sensor aunque hubiera timestamps empatados (desempata por id).
CREATE VIEW IF NOT EXISTS v_ultima_lectura AS
SELECT l.*
FROM lecturas l
WHERE NOT EXISTS (
    SELECT 1 FROM lecturas l2
    WHERE l2.sensor_index = l.sensor_index
      AND (l2.timestamp > l.timestamp
           OR (l2.timestamp = l.timestamp AND l2.id > l.id))
);
