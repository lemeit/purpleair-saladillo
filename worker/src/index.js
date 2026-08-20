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
        const { results } = await env.DB.prepare(
          `SELECT * FROM lecturas
           WHERE sensor_index = ?
           ORDER BY timestamp DESC
           LIMIT 200`
        )
          .bind(sensorIndex)
          .all();
        return json(results);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
