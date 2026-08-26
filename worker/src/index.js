/**
 * API de solo lectura + ingesta programada para la red de sensores de aire de
 * Saladillo (aq.lemeit.ar) — hoy PurpleAir y AirGradient conviven en las
 * mismas tablas sensores/lecturas de D1, así el dashboard los muestra
 * unificados en vez de necesitar un portal por fabricante.
 * Expone datos de la base D1 sin necesidad de exponer ningún token propio:
 * el binding a D1 se configura en wrangler.toml y Cloudflare lo
 * inyecta de forma segura en tiempo de ejecución.
 *
 * Endpoints:
 *   GET /api/sensores          -> metadata de todos los sensores (cualquier proveedor)
 *   GET /api/ultimas           -> última lectura de cada sensor (vista v_ultima_lectura)
 *   GET /api/historico/:index  -> historial de un sensor (últimas 200 lecturas)
 *
 * Ingesta (scheduled, ver [triggers] en wrangler.toml): reemplazó al cron de
 * GitHub Actions (`.github/workflows/purpleair-ingest.yml`) como camino
 * principal para PurpleAir — aunque terminó necesitando volver a sumarse
 * como respaldo por un problema del lado de Cloudflare (ver README.md →
 * "Historia de la ingesta automática"). ingest_purpleair.py se mantiene en
 * el repo como referencia / para correr ingestas puntuales a mano.
 *
 * AirGradient (agosto 2026) se sumó directo acá, sin script Python propio:
 * ver ingestAirGradient() más abajo — usa la API pública de AirGradient
 * (secret AIRGRADIENT_API_TOKEN) y auto-registra cada sensor nuevo que
 * aparece, sin necesitar una lista de IDs a mano.
 */
/**
 * API de solo lectura + ingesta programada para la red de sensores de aire de
 * Saladillo (aq.lemeit.ar) — PurpleAir y AirGradient unificados en D1.
 */
// ── Ingesta PurpleAir → D1 ─────────────────────────────────────────────────

const PURPLEAIR_FIELDS =
  "name,latitude,longitude,pm1.0,pm2.5,pm2.5_10minute,pm2.5_60minute,pm10.0," +
  "pm2.5_a,pm2.5_b,pm1.0_a,pm1.0_b,pm10.0_a,pm10.0_b,voc," +
  "temperature,humidity,pressure,rssi,last_seen";

function fahrenheitToCelsius(f) {
  if (f === null || f === undefined) return null;
  return Math.round((((f - 32) * 5) / 9) * 100) / 100;
}

function getField(row, fieldIndex, name) {
  const idx = fieldIndex[name];
  if (idx === undefined || idx >= row.length) return null;
  const v = row[idx];
  return v === undefined ? null : v;
}

async function fetchPurpleAirData(env) {
  const url = new URL("https://api.purpleair.com/v1/sensors");
  url.searchParams.set("fields", PURPLEAIR_FIELDS);
  url.searchParams.set("show_only", env.SENSOR_INDEXES);
  const resp = await fetch(url.toString(), {
    headers: { "X-API-Key": env.PURPLEAIR_API_KEY },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Error de la API de PurpleAir (${resp.status}): ${text}`);
  }
  return resp.json();
}

async function upsertSensorMetadata(env, sensorIndex, nombre, lat, lon) {
  await env.DB.prepare(
    `INSERT INTO sensores (sensor_index, nombre, latitud, longitud)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(sensor_index) DO UPDATE SET
       latitud = excluded.latitud,
       longitud = excluded.longitud`
  )
    .bind(sensorIndex, nombre, lat, lon)
    .run();
}

async function insertLectura(env, row, fieldIndex) {
  const sensorIndex = getField(row, fieldIndex, "sensor_index");
  const timestamp = getField(row, fieldIndex, "last_seen");
  await env.DB.prepare(
    `INSERT OR IGNORE INTO lecturas (
      sensor_index, timestamp, pm1_0, pm2_5, pm2_5_10min,
      pm2_5_60min, pm10_0, pm2_5_a, pm2_5_b, pm1_0_a, pm1_0_b,
      pm10_0_a, pm10_0_b, voc, temperatura, humedad, presion, rssi
    ) VALUES (?, datetime(?, 'unixepoch'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      sensorIndex,
      timestamp,
      getField(row, fieldIndex, "pm1.0"),
      getField(row, fieldIndex, "pm2.5"),
      getField(row, fieldIndex, "pm2.5_10minute"),
      getField(row, fieldIndex, "pm2.5_60minute"),
      getField(row, fieldIndex, "pm10.0"),
      getField(row, fieldIndex, "pm2.5_a"),
      getField(row, fieldIndex, "pm2.5_b"),
      getField(row, fieldIndex, "pm1.0_a"),
      getField(row, fieldIndex, "pm1.0_b"),
      getField(row, fieldIndex, "pm10.0_a"),
      getField(row, fieldIndex, "pm10.0_b"),
      getField(row, fieldIndex, "voc"),
      fahrenheitToCelsius(getField(row, fieldIndex, "temperature")),
      getField(row, fieldIndex, "humidity"),
      getField(row, fieldIndex, "pressure"),
      getField(row, fieldIndex, "rssi")
    )
    .run();
}

async function ingest(env) {
  const data = await fetchPurpleAirData(env);
  const fieldIndex = {};
  data.fields.forEach((name, i) => {
    fieldIndex[name] = i;
  });

  if (!data.data || !data.data.length) {
    return { ok: false, guardados: 0, error: "Sin datos de la API de PurpleAir" };
  }

  let guardados = 0;
  const errores = [];
  for (const row of data.data) {
    const sensorIndex = getField(row, fieldIndex, "sensor_index");
    const nombre = getField(row, fieldIndex, "name");
    const lat = getField(row, fieldIndex, "latitude");
    const lon = getField(row, fieldIndex, "longitude");
    try {
      await upsertSensorMetadata(env, sensorIndex, nombre, lat, lon);
      await insertLectura(env, row, fieldIndex);
      guardados++;
    } catch (err) {
      errores.push(`sensor ${sensorIndex}: ${err.message}`);
    }
  }
  return { ok: errores.length === 0, guardados, total: data.data.length, errores };
}

// ── Ingesta AirGradient → D1 ─────────────────────────────────────────────────

async function fetchAirGradientData(env) {
  const url = `https://api.airgradient.com/public/api/v1/locations/measures/current?token=${env.AIRGRADIENT_API_TOKEN}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Error de la API de AirGradient (${resp.status}): ${text}`);
  }
  return resp.json();
}

async function getOrAssignSensorIndex(env, serial) {
  const existente = await env.DB.prepare(
    `SELECT sensor_index FROM sensores WHERE serial_externo = ? AND proveedor = 'airgradient'`
  )
    .bind(serial)
    .first();
  if (existente) return existente.sensor_index;

  const fila = await env.DB.prepare(
    `SELECT COALESCE(MAX(sensor_index), 900000) + 1 AS siguiente
     FROM sensores WHERE proveedor = 'airgradient'`
  ).first();
  return fila.siguiente;
}

async function upsertAirGradientSensor(env, sensorIndex, serial, loc) {
  const nombreDefault = loc.locationName || serial;
  await env.DB.prepare(
    `INSERT INTO sensores (sensor_index, nombre, latitud, longitud, proveedor, serial_externo)
     VALUES (?, ?, ?, ?, 'airgradient', ?)
     ON CONFLICT(sensor_index) DO UPDATE SET
       latitud = excluded.latitud,
       longitud = excluded.longitud,
       serial_externo = excluded.serial_externo`
  )
    .bind(sensorIndex, nombreDefault, loc.latitude ?? null, loc.longitude ?? null, serial)
    .run();
}

async function insertAirGradientLectura(env, sensorIndex, loc) {
  if (!loc.timestamp) return;
  const timestamp = loc.timestamp.replace("T", " ").replace(/\.\d+Z$/, "").replace(/Z$/, "");

  await env.DB.prepare(
    `INSERT OR IGNORE INTO lecturas (
      sensor_index, timestamp, pm1_0, pm2_5, pm10_0, co2,
      voc, temperatura, humedad, rssi
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      sensorIndex,
      timestamp,
      loc.pm01 ?? null,
      loc.pm02 ?? null,
      loc.pm10 ?? null,
      loc.rco2 ?? null,
      loc.tvocIndex ?? null,
      loc.atmpCompensated ?? loc.atmp ?? null,
      loc.rhumCompensated ?? loc.rhum ?? null,
      loc.wifi ?? null
    )
    .run();
}

async function ingestAirGradient(env) {
  if (!env.AIRGRADIENT_API_TOKEN) {
    return { ok: false, guardados: 0, error: "AIRGRADIENT_API_TOKEN no configurado" };
  }

  const data = await fetchAirGradientData(env);
  if (!Array.isArray(data) || !data.length) {
    return { ok: false, guardados: 0, error: "Sin datos de la API de AirGradient" };
  }

  const permitidas = (env.AIRGRADIENT_LOCATION_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const locations = permitidas.length
    ? data.filter((loc) => permitidas.includes(String(loc.locationId)))
    : data;

  if (!locations.length) {
    return {
      ok: false,
      guardados: 0,
      error: "Ninguna location de la API coincide con AIRGRADIENT_LOCATION_IDS",
    };
  }

  let guardados = 0;
  const errores = [];
  for (const loc of locations) {
    const serial = loc.serialno || String(loc.locationId);
    try {
      const sensorIndex = await getOrAssignSensorIndex(env, serial);
      await upsertAirGradientSensor(env, sensorIndex, serial, loc);
      await insertAirGradientLectura(env, sensorIndex, loc);
      guardados++;
    } catch (err) {
      errores.push(`AirGradient ${serial}: ${err.message}`);
    }
  }
  return { ok: errores.length === 0, guardados, total: locations.length, errores };
}

// ── API de lectura ───────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Ingest-Key",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/sensores") {
        const { results } = await env.DB.prepare(
          "SELECT * FROM sensores WHERE activo = 1"
        ).all();
        return json(results);
      }

      if (path === "/api/ultimas") {
        const { results } = await env.DB.prepare(
          `SELECT l.*, s.nombre, s.institucion, s.latitud, s.longitud
           FROM v_ultima_lectura l
           JOIN sensores s ON s.sensor_index = l.sensor_index`
        ).all();
        return json(results);
      }

      const historicoMatch = path.match(/^\/api\/historico\/(\d+)$/);
      if (historicoMatch) {
        const sensorIndex = historicoMatch[1];
        const range = url.searchParams.get("range") || "24h";
        const rangeMap = { "24h": "-24 hours", "7d": "-7 days", "30d": "-30 days" };
        const modifier = rangeMap[range] || rangeMap["24h"];

        const { results } = await env.DB.prepare(
          `SELECT * FROM lecturas
           WHERE sensor_index = ?
             AND timestamp >= datetime('now', ?)
           ORDER BY timestamp ASC
           LIMIT 3000`
        )
          .bind(sensorIndex, modifier)
          .all();
        return json(results);
      }

      if (path === "/api/ingest-ahora" && request.method === "POST") {
        const key = request.headers.get("X-Ingest-Key");
        if (!env.INGEST_KEY || key !== env.INGEST_KEY) {
          return json({ error: "No autorizado" }, 401);
        }
        const resultado = await ingest(env);
        return json(resultado, resultado.ok ? 200 : 502);
      }

      if (path === "/api/ingest-ahora-airgradient" && request.method === "POST") {
        const key = request.headers.get("X-Ingest-Key");
        if (!env.INGEST_KEY || key !== env.INGEST_KEY) {
          return json({ error: "No autorizado" }, 401);
        }
        const resultado = await ingestAirGradient(env);
        return json(resultado, resultado.ok ? 200 : 502);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      Promise.all([
        ingest(env).catch((err) => console.error(`PurpleAir err: ${err.message}`)),
        ingestAirGradient(env).catch((err) => console.error(`AirGradient err: ${err.message}`)),
      ])
    );
  },
};
