/**
 * API de solo lectura para el proyecto PurpleAir Saladillo.
 * Expone datos de la base D1 sin necesidad de exponer ningún token:
 * el binding a D1 se configura en wrangler.toml y Cloudflare lo
 * inyecta de forma segura en tiempo de ejecución.
 *
 * Endpoints:
 *   GET /api/sensores          -> metadata de todos los sensores
 *   GET /api/ultimas           -> última lectura de cada sensor (vista v_ultima_lectura)
 *   GET /api/historico/:index  -> historial de un sensor (últimas 200 lecturas)
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
