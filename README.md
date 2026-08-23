# Aire Saladillo — Red de Sensores PurpleAir

Sistema de adquisición y visualización de calidad de aire (material particulado PM2.5/PM10) a partir de sensores PurpleAir instalados en escuelas y jardines de infantes de Saladillo, Buenos Aires, Argentina. Publicado en [aq.lemeit.ar](https://aq.lemeit.ar).

Es uno de tres proyectos de monitoreo ambiental que comparten la misma infraestructura de Cloudflare (Pages + Workers + D1), pensados para integrarse a futuro: [emas.lemeit.ar](https://emas.lemeit.ar) (meteorología), este (calidad del aire) y wq.lemeit.ar (calidad del agua, en desarrollo).

## Sensores

Cada sensor físico se registra en la tabla `sensores` (nombre, institución, coordenadas, estado activo/inactivo), independiente de la serie de lecturas — así se pueden dar de baja o agregar sensores sin perder el historial. El listado de instituciones vivas se administra desde ahí, no está hardcodeado en el dashboard.

## Arquitectura

```
ingest_purpleair.py (GitHub Actions, cron cada 15 min)
    ↓ (API PurpleAir → Cloudflare D1 HTTP API)
Cloudflare D1 — tablas "sensores" y "lecturas"
    ↓ (consultada por)
Worker "purpleair-saladillo-api" (Cloudflare Workers)
    ↓ (API REST propia, JSON)
Dashboard HTML estático (Cloudflare Pages) — aq.lemeit.ar
```

## Ingesta

| Script | Descripción |
|--------|-------------|
| `ingest_purpleair.py` | Consulta la API de PurpleAir (`api.purpleair.com/v1/sensors`) para los sensores propios, convierte temperatura de Fahrenheit a Celsius, y escribe metadata + lectura en D1 vía su API HTTP |

## Instalación local

```bash
pip install requests
```

## Variables de entorno (GitHub Actions)

El workflow `.github/workflows/purpleair-ingest.yml` corre `ingest_purpleair.py` cada 15 minutos. Se configuran como secrets del repositorio:

```
PURPLEAIR_API_KEY=...   # API key de lectura de develop.purpleair.com
SENSOR_INDEXES=...      # lista separada por comas, ej: "12345,67890"
CF_ACCOUNT_ID=...
CF_DATABASE_ID=9ced8d5e-e3ae-4718-a553-21e349368e1c
CF_API_TOKEN=...        # con permiso D1:Edit
```

## Dashboard

El archivo `index.html` (raíz del repo) es un single-file HTML estático que consulta el Worker de Cloudflare vía fetch/JSON. No requiere backend propio. Deployado en Cloudflare Pages (`wrangler pages deploy`).

Funcionalidad: tarjetas clickeables con el estado actual de cada sensor (AQI, PM2.5, temperatura, humedad), gráfico histórico con selector de rango (24h / 7d / 30d), overlay opcional de canales A/B del sensor (para detectar divergencia o degradación), exportación a CSV, y tema claro/oscuro persistido en `localStorage`.

## Base de datos (Cloudflare D1)

Base: `purpleair-saladillo` — tablas `sensores` (metadata) y `lecturas` (serie temporal), más la vista `v_ultima_lectura` (última lectura por sensor). Ver `schema.sql` para el esquema completo y `migration_001_canales.sql` para el agregado de columnas de canal A/B.

El Worker `worker/src/index.js` expone:

| Endpoint | Descripción |
|----------|-------------|
| `GET /api/sensores` | Metadata de todos los sensores activos |
| `GET /api/ultimas` | Última lectura de cada sensor |
| `GET /api/historico/:sensor_index?range=24h\|7d\|30d` | Historial de un sensor, filtrado por ventana de tiempo real (no por cantidad de filas) |

## Proyecto educativo

Red de sensores PurpleAir instalada en escuelas y jardines de infantes de Saladillo, con fines de monitoreo ambiental y educación ambiental ciudadana.
Ing. Luciano Lamaita — docente de Física y Química en Saladillo, Buenos Aires — más proyectos y materiales en [profe.lemeit.ar](https://profe.lemeit.ar)

## Contexto institucional y proyectos futuros

Notas para retomar en próximas sesiones de desarrollo (no son parte de la funcionalidad actual del dashboard):

- El autor (Ing. Luciano Lamaita) trabajó anteriormente en el **CEMCA** (Centro de Monitoreo de Calidad de Aire), dependiente del Ministerio de Ambiente de la Provincia de Buenos Aires — panel público en [apps.ambiente.gba.gob.ar/cemca](https://apps.ambiente.gba.gob.ar/cemca/). Se usó como referencia de diseño para el mapa de `aq.lemeit.ar` (selector de contaminante/capa de datos, mapa de estaciones).
- Hay planes de integrar proyectos en conjunto con el CEMCA/Min. de Ambiente PBA a futuro, mencionados como ejemplo: **colocation de sensores de bajo costo** (instalar sensores PurpleAir junto a estaciones oficiales certificadas para comparar/calibrar contra el equipo de referencia).
- Al retomar este tema, conviene revisar si hay wiki, contactos o documentación adicional que el autor quiera sumar antes de planificar la integración técnica (autenticación, formato de datos a compartir, etc.).

## Licencia

Datos: cortesía de la red comunitaria de sensores [PurpleAir](https://www.purpleair.com), uso educativo/informativo.
Código: MIT.
