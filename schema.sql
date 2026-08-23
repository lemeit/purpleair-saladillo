-- Schema para el proyecto de sensores PurpleAir de Saladillo
-- Cloudflare D1 (SQLite)

-- Metadata de cada sensor físico: dónde está instalado y su sensor_index de PurpleAir
CREATE TABLE IF NOT EXISTS sensores (
    sensor_index INTEGER PRIMARY KEY,     -- sensor_index que asigna PurpleAir al registrarlo
    nombre TEXT NOT NULL,                 -- nombre descriptivo, ej. "PurpleAir-9f3"
    institucion TEXT,                     -- nombre de la escuela/jardín donde está instalado
    latitud REAL,
    longitud REAL,
    activo INTEGER DEFAULT 1,             -- 1 = actualmente instalado y monitoreado, 0 = de baja/en tránsito
    fecha_instalacion TEXT,               -- ISO8601, opcional
    notas TEXT
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
    creado_en TEXT DEFAULT (datetime('now'))
);

-- Índices para las consultas típicas: por sensor y por rango de fecha
CREATE INDEX IF NOT EXISTS idx_lecturas_sensor_ts ON lecturas (sensor_index, timestamp);
CREATE INDEX IF NOT EXISTS idx_lecturas_ts ON lecturas (timestamp);

-- Vista de última lectura por sensor, útil para el dashboard "estado actual"
CREATE VIEW IF NOT EXISTS v_ultima_lectura AS
SELECT l.*
FROM lecturas l
INNER JOIN (
    SELECT sensor_index, MAX(timestamp) AS max_ts
    FROM lecturas
    GROUP BY sensor_index
) ult ON l.sensor_index = ult.sensor_index AND l.timestamp = ult.max_ts;
