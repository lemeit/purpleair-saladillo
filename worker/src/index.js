/**
 * API de solo lectura + ingesta programada para el proyecto PurpleAir Saladillo.
 * Expone datos de la base D1 sin necesidad de exponer ningún token:
 * el binding a D1 se configura en wrangler.toml y Cloudflare lo
 * inyecta de forma segura en tiempo de ejecución.
 *
 * Endpoints:
 *   GET /api/sensores          -> metadata de todos los sensores
 *   GET /api/ultimas           -> última lectura de cada sensor (vista v_ultima_lectura)
 *   GET /api/historico/:index  -> historial de un sensor (últimas 200 lecturas)
 *
 * Ingesta (scheduled, ver [triggers] en wrangler.toml): reemplaza el cron de
 * GitHub Actions (`.github/workflows/purpleair-ingest.yml`, ahora solo
 * workflow_dispatch manual) — la ejecución programada y el guardado en D1
 * pasan a depender únicamente de Cloudflare, no de la cola de scheduled
 * events de GitHub (que es la que venía salteando corridas). Reescribe
 * ingest_purpleair.py línea por línea usando el binding env.DB en vez de
 * la API HTTP de D1 (por eso ya no hace falta CF_ACCOUNT_ID/CF_DATABASE_ID/
 * CF_API_TOKEN acá — solo PURPLEAIR_API_KEY y SENSOR_INDEXES como secrets).
 * ingest_purpleair.py se mantiene en el repo como referencia / para correr
 * ingestas puntuales a mano desde una máquina local, ya no como el camino
 * principal.
 */

// ── Ingesta PurpleAir → D1 ─────────────────────────────────────────────────

const PURPLEAIR_FIELDS =
  "name,latitude,longitude,pm1.0,pm2.5,pm2.5_10minute,pm2.5_60minute,pm10.0," +
  "pm2.5_a,pm2.5_b,pm1.0_a,pm1.0_b,pm10.0_a,pm10.0_b,voc," +
  "temperature,humidity,pressure,rssi,last_seen";
// Mismos campos que ingest_purpleair.py — ver las notas sobre "voc" ahí
// (BME68x, null en sensores sin ese chip; "gas_680" no es válido en la API v1).

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
       nombre = excluded.nombre,
       latitud = excluded.latitud,
       longitud = excluded.longitud`
  )
    .bind(sensorIndex, nombre, lat, lon)
    .run();
}

async function insertLectura(env, row, fieldIndex) {
  const sensorIndex = getField(row, fieldIndex, "sensor_index");
  const timestamp = getField(row, fieldIndex, "last_seen");
  // INSERT OR IGNORE + UNIQUE(sensor_index, timestamp) en schema.sql: si el
  // sensor está desconectado y PurpleAir repite el mismo last_seen corrida
  // tras corrida, esto no-opea en silencio en vez de crear una fila nueva
  // (ver migration_003_dedupe_lecturas.sql para el porqué).
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

// ── API de lectura (sin cambios) ────────────────────────────────────────────

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

      // Disparo manual de la ingesta, para probar sin esperar al cron ni pasar
      // por el dashboard. Protegido con el mismo tipo de clave que el panel de
      // Ubicaciones de agua-saladillo (secret validado en el servidor, nunca
      // en el código ni en el repo).
      if (path === "/api/ingest-ahora" && request.method === "POST") {
        const key = request.headers.get("X-Ingest-Key");
        if (!env.INGEST_KEY || key !== env.INGEST_KEY) {
          return json({ error: "No autorizado" }, 401);
        }
        const resultado = await ingest(env);
        return json(resultado, resultado.ok ? 200 : 502);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },

  // Cron Trigger (ver [triggers] en wrangler.toml) — reemplaza al cron de
  // GitHub Actions como disparador de la ingesta cada 15 minutos.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      ingest(env)
        .then((resultado) => {
          console.log(`Ingesta programada: ${JSON.stringify(resultado)}`);
        })
        .catch((err) => {
          console.error(`Fallo la ingesta programada: ${err.message}`);
        })
    );
  },
};