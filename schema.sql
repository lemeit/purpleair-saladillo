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
    nox REAL,                             -- índice NOx (sensor SGP41), solo AirGradient (ver migration_005) — NULL en filas de PurpleAir
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
-- Ver migration_006_optimizar_vista_ultima_lectura.sql: la versión original
-- usaba NOT EXISTS correlacionado, que recorría TODA la tabla lecturas en
-- cada consulta (/api/ultimas, llamado cada 5 min por pestaña abierta) y
-- fue la causa principal de agotar la cuota gratuita de D1 (5M rows_read/
-- día) el 2026-09-01, a medida que la tabla creció con meses de ingesta.
-- migration_003_dedupe_lecturas.sql ya garantiza como máximo una fila por
-- (sensor_index, timestamp) -- índice UNIQUE idx_lecturas_sensor_ts_unique --
-- así que GROUP BY + MAX(timestamp) alcanza, sin desempate por id, y con
-- el índice idx_lecturas_sensor_ts (sensor_index, timestamp) SQLite lo
-- resuelve leyendo ~1 fila por sensor en vez de la tabla entera.
CREATE VIEW IF NOT EXISTS v_ultima_lectura AS
SELECT l.*
FROM lecturas l
JOIN (
    SELECT sensor_index, MAX(timestamp) AS ts
    FROM lecturas
    GROUP BY sensor_index
) m ON m.sensor_index = l.sensor_index AND m.ts = l.timestamp;

-- Registro mínimo de accesos a la API, para saber quién usa el portal sin
-- depender de un panel externo (ver migration_007_visitas.sql y los
-- endpoints /api/admin/visitas y /api/admin/resumen en worker/src/index.js).
CREATE TABLE IF NOT EXISTS visitas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  path TEXT,
  pais TEXT,
  referrer TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_visitas_ts ON visitas(ts);
