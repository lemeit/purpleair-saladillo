/**
 * API de solo lectura + ingesta programada para la red de sensores de aire de
 * Saladillo (aq.lemeit.ar) — hoy PurpleAir y AirGradient conviven en las
 * mismas tablas sensores/lecturas de D1, así el dashboard los muestra
 * unificados en vez de necesitar un portal por fabricante.
 * Expone datos de la base D1 sin necesidad de exponer ningún token propio:
 * el binding a D1 se configura en wrangler.toml y Cloudflare lo
 * inyecta de forma segura en tiempo de ejecución.
 *
 * Endpoints (API pública, de solo lectura — sin autenticación, CORS abierto):
 *   GET /api/sensores          -> metadata de todos los sensores (cualquier proveedor)
 *   GET /api/ultimas           -> última lectura de cada sensor (vista v_ultima_lectura)
 *   GET /api/historico/:index  -> historial de un sensor
 *       ?range=24h|7d|30d        ventana relativa (default 24h)
 *       ?desde=YYYY-MM-DD[ HH:MM:SS]&hasta=... rango de fechas absoluto en UTC
 *                                 (si viene desde y/o hasta, pisa a "range")
 *       ?limit=N                 tope de filas (default 3000, máximo 20000)
 *   Los tres endpoints aceptan &formato=csv para descargar CSV en vez de JSON.
 *   Documentación con ejemplos: /api.html en aq.lemeit.ar
 *
 *   GET /api/admin/visitas?limit=200  -> log crudo de accesos (header X-Admin-Key, requiere ADMIN_KEY)
 *   GET /api/admin/resumen            -> totales + top paths/países (header X-Admin-Key, requiere ADMIN_KEY)
 *
 * Ingesta (scheduled, ver [triggers] en wrangler.toml): reemplazó al cron de
 * GitHub Actions (`.github/workflows/purpleair-ingest.yml`) como camino
 * principal para PurpleAir.
 *
 * AirGradient (agosto 2026) consulta los proyectos de "OpenAQ Ambassadors"
 * y "Saladillo" de forma independiente utilizando secretos de Cloudflare.
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
  // "proveedor" se fija explícitamente en el INSERT (no depende de un
  // DEFAULT del esquema) pero no se toca en el UPDATE, mismo criterio que
  // "nombre": si alguna vez se corrige a mano en D1, la ingesta periódica
  // no lo pisa.
  await env.DB.prepare(
    `INSERT INTO sensores (sensor_index, nombre, latitud, longitud, proveedor)
     VALUES (?, ?, ?, ?, 'purpleair')
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
  const tokens = [];

  if (env.AIRGRADIENT_TOKEN_OPENAQ) {
    tokens.push({ name: "OpenAQ Ambassadors", token: env.AIRGRADIENT_TOKEN_OPENAQ });
  }
  if (env.AIRGRADIENT_TOKEN_SALADILLO) {
    tokens.push({ name: "Saladillo", token: env.AIRGRADIENT_TOKEN_SALADILLO });
  }

  if (!tokens.length) {
    throw new Error("No hay secretos configurados para AirGradient (AIRGRADIENT_TOKEN_OPENAQ o AIRGRADIENT_TOKEN_SALADILLO)");
  }

  let todasLasLocations = [];

  for (const item of tokens) {
    try {
      const url = `https://api.airgradient.com/public/api/v1/locations/measures/current?token=${item.token}`;
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data)) {
          todasLasLocations = todasLasLocations.concat(data);
        }
      } else {
        console.error(`Error en token ${item.name} (${resp.status})`);
      }
    } catch (err) {
      console.error(`Error consultando token ${item.name}: ${err.message}`);
    }
  }

  return todasLasLocations;
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
      voc, nox, temperatura, humedad, rssi
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      sensorIndex,
      timestamp,
      loc.pm01 ?? null,
      loc.pm02 ?? null,
      loc.pm10 ?? null,
      loc.rco2 ?? null,
      loc.tvocIndex ?? null,
      loc.noxIndex ?? null,
      loc.atmpCompensated ?? loc.atmp ?? null,
      loc.rhumCompensated ?? loc.rhum ?? null,
      loc.wifi ?? null
    )
    .run();
}

async function ingestAirGradient(env) {
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
  "Access-Control-Allow-Headers": "Content-Type, X-Ingest-Key, X-Admin-Key",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// ── Exportación CSV ─────────────────────────────────────────────────────────
// Las columnas del CSV se toman de las claves de la primera fila devuelta por
// D1 (mismo orden que el SELECT), así que nunca se desincroniza del esquema
// real: si mañana se agrega una columna a la tabla, el CSV la incluye sola.
function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map((h) => escape(r[h])).join(","));
  return lines.join("\n");
}

function csvResponse(rows, filename) {
  return new Response(toCsv(rows), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      ...CORS_HEADERS,
    },
  });
}

function wantsCsv(url) {
  return (url.searchParams.get("formato") || "").toLowerCase() === "csv";
}

// ── Registro de visitas + admin básico ──────────────────────────────────────
// Log mínimo de accesos (sin cookies ni terceros): cada GET público inserta
// una fila en D1 con timestamp, path, país (lo resuelve Cloudflare gratis en
// request.cf) y user-agent/referrer, en segundo plano (ctx.waitUntil) para
// no demorar la respuesta real. Se excluyen /api/admin/* y los tiles del
// mapa. Dos endpoints de solo lectura, protegidos por un secret compartido
// (`wrangler secret put ADMIN_KEY`) enviado como header `X-Admin-Key`
// (mismo esquema que X-Ingest-Key en /api/ingest-ahora) — sin panel, solo JSON:
//   GET /api/admin/visitas?limit=200   -> últimas N visitas, crudas
//   GET /api/admin/resumen             -> totales + top paths/países
function logVisita(env, ctx, request, path) {
  if (!ctx || !ctx.waitUntil || !env.DB) return;
  const cf = request.cf || {};
  const pais = cf.country || null;
  const referrer = (request.headers.get("Referer") || "").slice(0, 300) || null;
  const userAgent = (request.headers.get("User-Agent") || "").slice(0, 300) || null;
  ctx.waitUntil(
    env.DB.prepare(
      "INSERT INTO visitas (path, pais, referrer, user_agent) VALUES (?, ?, ?, ?)"
    )
      .bind(path, pais, referrer, userAgent)
      .run()
      .catch((err) => console.error(`logVisita: ${err.message}`))
  );
}

function autorizadoAdmin(request, env) {
  const key = request.headers.get("X-Admin-Key");
  return Boolean(env.ADMIN_KEY) && key === env.ADMIN_KEY;
}

// ── Proxy de tiles del mapa (CARTO Basemaps) ────────────────────────────────
// CARTO ahora exige una API key para servir tiles. En vez de poner esa key
// en el HTML público (cualquiera podría copiarla de "ver código fuente" y
// gastar la cuota gratuita de 5M tiles/mes), el frontend le pide los tiles a
// este Worker y es el Worker quien agrega la key en el secret CARTO_API_KEY
// (`wrangler secret put CARTO_API_KEY`, nunca en este archivo ni en
// wrangler.toml) al pedirle el tile a CARTO. Así la key nunca queda expuesta
// del lado del cliente.
const TILE_STYLES = new Set(["light_all", "dark_all"]);
const TILE_SUBDOMAINS = "abcd";

async function proxyCartoTile(env, style, z, x, y, retina) {
  if (!TILE_STYLES.has(style)) return json({ error: "Estilo de tile inválido" }, 400);
  if (!env.CARTO_API_KEY) return json({ error: "Falta configurar el secret CARTO_API_KEY" }, 500);
  const sub = TILE_SUBDOMAINS[Math.floor(Math.random() * TILE_SUBDOMAINS.length)];
  const cartoUrl = `https://${sub}.basemaps.cartocdn.com/${style}/${z}/${x}/${y}${retina}.png?key=${env.CARTO_API_KEY}`;
  const resp = await fetch(cartoUrl, { cf: { cacheTtl: 604800, cacheEverything: true } });
  if (!resp.ok) return new Response("Error obteniendo el tile de CARTO", { status: resp.status });
  const headers = new Headers();
  headers.set("Content-Type", resp.headers.get("Content-Type") || "image/png");
  headers.set("Cache-Control", "public, max-age=604800");
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(resp.body, { status: 200, headers });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    const tileMatch = path.match(/^\/tiles\/(light_all|dark_all)\/(\d+)\/(-?\d+)\/(-?\d+)(@2x)?\.png$/);
    if (tileMatch) {
      const [, style, z, x, y, retina] = tileMatch;
      return proxyCartoTile(env, style, z, x, y, retina || "");
    }

    if (request.method === "GET" && !path.startsWith("/api/admin/")) {
      logVisita(env, ctx, request, path);
    }

    try {
      if (path === "/api/sensores") {
        const { results } = await env.DB.prepare(
          "SELECT * FROM sensores WHERE activo = 1"
        ).all();
        if (wantsCsv(url)) return csvResponse(results, "sensores.csv");
        return json(results);
      }

      if (path === "/api/ultimas") {
        const { results } = await env.DB.prepare(
          `SELECT l.*, s.nombre, s.institucion, s.latitud, s.longitud, s.proveedor
           FROM v_ultima_lectura l
           JOIN sensores s ON s.sensor_index = l.sensor_index`
        ).all();
        if (wantsCsv(url)) return csvResponse(results, "ultimas_lecturas.csv");
        return json(results);
      }

      const historicoMatch = path.match(/^\/api\/historico\/(\d+)$/);
      if (historicoMatch) {
        const sensorIndex = historicoMatch[1];
        const desde = url.searchParams.get("desde");
        const hasta = url.searchParams.get("hasta");
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "3000", 10) || 3000, 20000);

        let where = "sensor_index = ?";
        const binds = [sensorIndex];

        if (desde || hasta) {
          // Rango de fechas absoluto en UTC, ej: ?desde=2026-08-01&hasta=2026-08-15
          if (desde) { where += " AND timestamp >= ?"; binds.push(desde); }
          if (hasta) { where += " AND timestamp <= ?"; binds.push(hasta); }
        } else {
          // Sin desde/hasta: se mantiene el comportamiento previo por ventana relativa.
          const range = url.searchParams.get("range") || "24h";
          const rangeMap = { "24h": "-24 hours", "7d": "-7 days", "30d": "-30 days" };
          const modifier = rangeMap[range] || rangeMap["24h"];
          where += " AND timestamp >= datetime('now', ?)";
          binds.push(modifier);
        }

        const sql = `SELECT * FROM lecturas WHERE ${where} ORDER BY timestamp ASC LIMIT ?`;
        binds.push(limit);
        const { results } = await env.DB.prepare(sql).bind(...binds).all();
        if (wantsCsv(url)) return csvResponse(results, `sensor_${sensorIndex}_historico.csv`);
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

      if (path === "/api/admin/visitas") {
        if (!autorizadoAdmin(request, env)) return json({ error: "No autorizado" }, 401);
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 2000);
        const { results } = await env.DB.prepare(
          "SELECT id, ts, path, pais, referrer, user_agent FROM visitas ORDER BY id DESC LIMIT ?"
        )
          .bind(limit)
          .all();
        return json(results);
      }

      if (path === "/api/admin/resumen") {
        if (!autorizadoAdmin(request, env)) return json({ error: "No autorizado" }, 401);
        const [ultimas24h, ultimos7d, topPaths, topPaises] = await Promise.all([
          env.DB.prepare("SELECT COUNT(*) AS n FROM visitas WHERE ts >= datetime('now', '-1 day')").first(),
          env.DB.prepare("SELECT COUNT(*) AS n FROM visitas WHERE ts >= datetime('now', '-7 days')").first(),
          env.DB.prepare(
            "SELECT path, COUNT(*) AS n FROM visitas WHERE ts >= datetime('now', '-7 days') GROUP BY path ORDER BY n DESC LIMIT 10"
          ).all(),
          env.DB.prepare(
            "SELECT pais, COUNT(*) AS n FROM visitas WHERE ts >= datetime('now', '-7 days') GROUP BY pais ORDER BY n DESC LIMIT 10"
          ).all(),
        ]);
        return json({
          visitas_ultimas_24h: ultimas24h.n,
          visitas_ultimos_7d: ultimos7d.n,
          top_paths_7d: topPaths.results,
          top_paises_7d: topPaises.results,
        });
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
