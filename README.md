# Aire Saladillo — Red de Sensores PurpleAir + AirGradient

Sistema de adquisición y visualización de calidad de aire (material particulado PM2.5/PM10, y desde agosto 2026 también CO2) a partir de sensores de bajo costo **PurpleAir** y **AirGradient** instalados en escuelas, jardines de infantes y domicilios de Saladillo, Buenos Aires, Argentina. Publicado en [aq.lemeit.ar](https://aq.lemeit.ar).

Es uno de tres proyectos de monitoreo ambiental que comparten la misma infraestructura de Cloudflare (Pages + Workers + D1), pensados para integrarse a futuro: [emas.lemeit.ar](https://emas.lemeit.ar) (meteorología), este (calidad del aire) y [wq.lemeit.ar](https://wq.lemeit.ar) (calidad del agua).

## Sensores

Cada sensor físico se registra en la tabla `sensores` (nombre, institución, coordenadas, estado activo/inactivo, proveedor), independiente de la serie de lecturas — así se pueden dar de baja o agregar sensores sin perder el historial. El listado de instituciones vivas se administra desde ahí, no está hardcodeado en el dashboard.

**Flota PurpleAir (agosto 2026)**: el autor tiene 5 unidades PurpleAir Flex en total. Una sola está instalada y activa online hoy; las otras 4 están pendientes de instalación/configuración en distintas instituciones. Como todo el hardware es Flex (sensor de gas BME688 incluido), el campo VOC debería poblarse en todos los sensores a medida que se vayan sumando — no es una excepción de un solo sensor.

**Flota AirGradient (agosto 2026)**: el autor tiene 3 unidades AirGradient en total, pero solo 2 corresponden a la red de Saladillo (la tercera está instalada en la UTN La Plata, otra institución/ciudad, y queda excluida del dashboard vía `AIRGRADIENT_LOCATION_IDS` — ver más abajo). De las 2 de Saladillo, una está en interior (domicilio del autor, ya reportando) y la otra (kit DIY) todavía no está instalada — la ubicación actual en el mapa es provisoria hasta que se defina dónde va a quedar montada. A diferencia de PurpleAir, AirGradient sí mide **CO2** (sensor NDIR), que se suma como parámetro nuevo en tarjetas, gráfico, mapa e historial.

## Arquitectura

```
Tres disparadores independientes, cada 15 min, en minutos escalonados:
  · Cloudflare Cron Trigger   :03 :18 :33 :48  → Worker.scheduled()
  · GitHub Actions schedule   :07 :22 :37 :52  → ingest_purpleair.py
  · cron-job.org (externo)    :12 :27 :42 :57  → POST /api/ingest-ahora
                    ↓ (cualquiera de los tres que dispare, termina en:)
Cloudflare D1 — tablas "sensores" y "lecturas"
  (dedupe automático — INSERT OR IGNORE + UNIQUE(sensor_index, timestamp) —
   así que no importa si dos o los tres corren casi al mismo tiempo)
    ↓ (consultada por)
Worker "purpleair-saladillo-api" — fetch() (API REST propia, JSON)
    ↓
Dashboard HTML estático (Cloudflare Pages) — aq.lemeit.ar
```

## Historia de la ingesta automática (agosto 2026)

**Primer intento — GitHub Actions solo.** La ingesta corría como `ingest_purpleair.py` disparado por un `cron:` de GitHub Actions cada 15 min. Ese cron empezó a saltear corridas (el último dato quedaba viejo por más de una hora sin ningún error ni corrida fallida visible) — la causa más probable, según la propia documentación de GitHub, es que los scheduled events "pueden demorarse durante períodos de alta carga", con los minutos redondos (:00/:15/:30/:45) como el momento de mayor congestión.

**Segundo intento — migración a Cloudflare.** Para sacar la ejecución de la cola de GitHub, la ingesta se reescribió dentro del mismo Worker que ya servía la API de lectura (`worker/src/index.js`, función `scheduled()`), disparada por un **Cron Trigger de Cloudflare** (`worker/wrangler.toml`, `[triggers] crons`) en los minutos :03/:18/:33/:48, y el `schedule:` de GitHub se sacó del todo (quedó solo `workflow_dispatch`). En la práctica, el Cron Trigger quedó **registrado correctamente en todos los lugares donde se lo verificó** (dashboard de Cloudflare, `wrangler deploy`, `wrangler.toml` local y en GitHub) pero **nunca disparó `scheduled()`** — confirmado cruzando el log propio de llamados a la API de PurpleAir (cero llamados durante horas), las filas de D1 (sin lecturas nuevas), `wrangler tail` y los Workers Logs del dashboard en tiempo real (ninguno mostró un evento de tipo cron, ni siquiera cruzando marcas horarias exactas), y probando borrar y re-crear el trigger desde cero. Esto coincide con varios reportes de otros usuarios de Cloudflare en 2026 con el mismo síntoma exacto ("Cron Trigger registrado pero `scheduled()` nunca invocado") — parece un bug del lado de Cloudflare, no algo corregible desde este repo.

**Solución actual — triple redundancia.** En vez de esperar a que Cloudflare lo resuelva, se reactivó el `schedule:` de GitHub Actions (ahora en minutos :07/:22/:37/:52, para no coincidir con los de Cloudflare) y se sumó un tercer disparador externo, **cron-job.org**, que hace `POST /api/ingest-ahora` en los minutos :12/:27/:42/:57. Los tres quedan corriendo en paralelo — el `INSERT OR IGNORE` + el índice `UNIQUE(sensor_index, timestamp)` en `lecturas` (ver "Base de datos" más abajo) garantiza que no se dupliquen filas aunque dos o los tres disparen casi al mismo tiempo. El Cron Trigger de Cloudflare se dejó configurado (no cuesta nada tenerlo) por si el bug se resuelve solo del lado de ellos; conviene revisar de vez en cuando la pestaña **Observability** del Worker en el dashboard de Cloudflare (`worker/wrangler.toml` tiene `[observability.logs] enabled = true` para que esos logs queden guardados) — si algún día aparece ahí un evento de cron exitoso, es la señal de que se puede volver a simplificar sacando GitHub Actions y/o cron-job.org.

## Integración AirGradient (agosto 2026)

Además de PurpleAir, el Worker ahora ingesta datos de sensores **AirGradient** contra su propia API pública (`GET /public/api/v1/locations/measures/current?token=...`, que devuelve en una sola llamada todas las ubicaciones visibles para ese token — no hace falta enumerar cada `locationId` en el código).

**Esquema unificado, sin repo aparte.** En vez de un portal separado, los sensores AirGradient se guardan en las mismas tablas `sensores`/`lecturas` que PurpleAir (ver `migration_004_airgradient.sql`), para que el dashboard los muestre juntos y el usuario no tenga que ir y venir entre dos sitios. Como `sensor_index` sigue siendo el `INTEGER PRIMARY KEY` de siempre y los sensores AirGradient no tienen un equivalente numérico propio, el Worker les asigna automáticamente un ID sintético en el rango 900000+ la primera vez que ve un `serialno` nuevo (columna `serial_externo`, para reconocerlo en corridas siguientes sin volver a asignarle otro número). La columna `proveedor` (`'purpleair'` | `'airgradient'`) distingue el origen de cada fila.

**Filtro por `AIRGRADIENT_LOCATION_IDS`.** El token del autor puede ver sensores que no son de la red de Saladillo (uno está en la UTN La Plata, otra institución/ciudad) — sin filtro, ese sensor aparecería igual en el dashboard de Saladillo. El secret `AIRGRADIENT_LOCATION_IDS` (lista de `locationId` separados por coma) restringe la ingesta a los sensores correctos; si no está seteado, el Worker ingesta todo lo que el token pueda ver (pensado como fallback, útil solo si el token ya está acotado de entrada). Nota: este filtro solo afecta ingestas *nuevas* — no borra retroactivamente filas ya guardadas antes de activarlo (hubo que limpiar a mano con `DELETE FROM lecturas/sensores WHERE sensor_index = ...` una vez que esto pasó en la práctica).

**Endpoint de prueba/backfill**: `POST /api/ingest-ahora-airgradient`, mismo esquema de auth que `/api/ingest-ahora` (header `X-Ingest-Key`). El `scheduled()` del Worker corre la ingesta de PurpleAir y de AirGradient en paralelo (`Promise.all`), cada una con su propio try/catch para que una falla en un proveedor no tumbe al otro.

**CO2 en el dashboard**: PurpleAir no mide CO2 (su BME68x da VOC, no CO2 real); AirGradient sí, vía sensor NDIR. El campo `co2` se agregó como parámetro más en el selector multi-parámetro del gráfico, como capa nueva en el mapa, como columna condicional en la tabla de historial y como tarjeta métrica adicional en las cards — todos siguiendo el mismo patrón "oculto salvo que el sensor lo reporte" que ya existía para VOC.

## Ingesta

Los tres caminos automáticos hacen lo mismo (consultar `api.purpleair.com/v1/sensors` y guardar en D1) y corren en paralelo sin riesgo de duplicar datos — ver la nota de dedupe en "Base de datos" más abajo.

| Camino | Descripción |
|--------|-------------|
| `worker/src/index.js` → `scheduled()` | Cron Trigger de Cloudflare, minutos :03/:18/:33/:48. **Estado (agosto 2026): registrado correctamente pero sin disparar** — ver "Historia de la ingesta automática" arriba. Cuando dispara, convierte temperatura de Fahrenheit a Celsius y escribe metadata + lectura en D1 vía el binding `env.DB`, sin HTTP intermedio. |
| `.github/workflows/purpleair-ingest.yml` (`schedule:`) | GitHub Actions, minutos :07/:22/:37/:52. Corre `ingest_purpleair.py`, misma lógica en Python, escribiendo a D1 vía su API HTTP. Activo, pero con delays variables e inconsistentes (documentado por GitHub como comportamiento esperado bajo carga — en la práctica, huecos de 30-55 min en vez de 15). |
| cron-job.org (externo) | Servicio de cron gratuito, minutos :12/:27/:42/:57. Hace `POST /api/ingest-ahora` con el header `X-Ingest-Key`. Sumado en agosto de 2026 porque ni el Cron Trigger de Cloudflare ni el `schedule:` de GitHub resultaron 100% confiables por separado. La configuración del job vive solo en el panel de cron-job.org, no está versionada en este repo. |
| `POST /api/ingest-ahora` | Disparo manual directo (usado también por cron-job.org). Requiere header `X-Ingest-Key` con el secret `INGEST_KEY`; sirve para pruebas o backfill puntual sin esperar a ningún cron. |

## Instalación local (solo para correr `ingest_purpleair.py` a mano)

```bash
pip install requests
```

## Variables de entorno / secrets

**Worker** (`wrangler secret put`, dentro de `worker/`):

```
PURPLEAIR_API_KEY        # API key de lectura de develop.purpleair.com
SENSOR_INDEXES           # lista separada por comas, ej: "12345,67890"
INGEST_KEY               # clave propia para disparar POST /api/ingest-ahora — usada
                          # también por cron-job.org (ver Historia de la ingesta arriba).
                          # Rotada en agosto 2026 (la anterior era corta y quedó
                          # expuesta en una charla de diagnóstico). Cloudflare no
                          # permite leer secrets ya guardados — para verificar que
                          # el valor actual es correcto, la forma es pegarle a
                          # POST /api/ingest-ahora y confirmar que responde
                          # {"ok":true,...} en vez de 401.
AIRGRADIENT_API_TOKEN     # token de la API pública de AirGradient (dashboard → Place settings)
AIRGRADIENT_LOCATION_IDS  # lista separada por comas de locationId a ingestar — filtra
                          # sensores fuera de la red de Saladillo (ver "Integración
                          # AirGradient" arriba). Si no está seteado, ingesta todo lo
                          # que el token pueda ver.
```

`worker/wrangler.toml` también tiene un bloque `[observability]` con `logs.enabled = true` (activado en agosto 2026 para diagnosticar el problema del Cron Trigger) — no es un secret, pero cualquier cambio ahí necesita `wrangler deploy` para tomar efecto, un toggle desde el dashboard solo no alcanza.

**GitHub Actions** (Settings → Secrets and variables → Actions del repo; usados tanto por el `schedule:` activo como por `workflow_dispatch` manual):

```
PURPLEAIR_API_KEY=...
SENSOR_INDEXES=...
CF_ACCOUNT_ID=...
CF_DATABASE_ID=9ced8d5e-e3ae-4718-a553-21e349368e1c
CF_API_TOKEN=...        # con permiso D1:Edit
```

**cron-job.org**: no usa secrets de GitHub ni de Cloudflare — la clave `INGEST_KEY` se pega directamente como header custom (`X-Ingest-Key`) en la configuración del job, ahí es donde vive por fuera de este repo.

## Dashboard

El archivo `index.html` (raíz del repo) es un single-file HTML estático que consulta el Worker de Cloudflare vía fetch/JSON. No requiere backend propio. Deployado en Cloudflare Pages (`wrangler pages deploy`).

Funcionalidad: tarjetas clickeables con el estado actual de cada sensor (AQI, PM2.5, temperatura, humedad), gráfico histórico con selector de rango (24h / 7d / 30d), overlay opcional de canales A/B del sensor (para detectar divergencia o degradación), exportación a CSV, y tema claro/oscuro persistido en `localStorage`.

Si un sensor deja de reportar lecturas nuevas hace más de 25 minutos (se desconectó, se quedó sin señal, etc.), su tarjeta lo indica: el badge cambia a "Sin datos" en gris neutro (no un color de calidad de aire, porque ese dato ya quedó viejo), el velocímetro de AQI se atenúa, y aparece un aviso "⚠ Sin datos nuevos hace más de 25 min" debajo del horario de última actualización. Aplica tanto a la grilla de "Actuales" como a las tarjetas del "Mapa" (comparten la misma función de armado de tarjeta); la pestaña "Gráfico" no tiene grilla de tarjetas, solo el histórico del sensor seleccionado.

## Base de datos (Cloudflare D1)

Base: `purpleair-saladillo` — tablas `sensores` (metadata) y `lecturas` (serie temporal), más la vista `v_ultima_lectura` (última lectura por sensor). Ver `schema.sql` para el esquema completo, `migration_001_canales.sql` para el agregado de columnas de canal A/B, `migration_002_mas_campos.sql` para VOC y canales A/B de PM1.0/PM10.0, y `migration_003_dedupe_lecturas.sql` para el fix de tarjetas duplicadas descripto abajo.

**Fix: tarjetas duplicadas/triplicadas al desconectarse un sensor (agosto 2026)** — cuando un sensor pierde conexión, la API de PurpleAir sigue devolviendo su último `last_seen` (congelado, no cambia). El `INSERT` de `ingest_purpleair.py` no chequeaba duplicados, así que cada corrida del cron (cada 15 min) agregaba una fila nueva con ese mismo timestamp, y `v_ultima_lectura` (que hacía `MAX(timestamp)` + `JOIN`) devolvía **todas** las filas empatadas en vez de una sola — de ahí las tarjetas repetidas. Se corrigió con tres cambios: un índice `UNIQUE(sensor_index, timestamp)` en `lecturas`, `ingest_purpleair.py` usando `INSERT OR IGNORE` (no-opea si esa lectura exacta ya existe), y `v_ultima_lectura` redefinida para garantizar como máximo una fila por sensor aunque hubiera timestamps empatados. `migration_003_dedupe_lecturas.sql` limpia los duplicados ya acumulados en la base real — se corre a mano con `wrangler d1 execute`. **Importante**: recordar correr esta migración contra la base remota después de cualquier cambio de esquema — quedó pendiente sin ejecutar una vez y causó que `/api/ultimas` mostrara datos viejos por varias horas aunque `lecturas` ya tuviera filas nuevas.

Este mismo mecanismo (`INSERT OR IGNORE` + `UNIQUE(sensor_index, timestamp)`) es lo que permite tener **tres disparadores de ingesta corriendo en paralelo** (Cron Trigger de Cloudflare, GitHub Actions y cron-job.org — ver "Historia de la ingesta automática" arriba) sin generar filas duplicadas: si dos caminos traen la misma lectura, el segundo `INSERT` simplemente no-opea; si traen lecturas distintas porque el sensor ya avanzó, cada una queda guardada como un punto más en el histórico, no como un duplicado.

El Worker `worker/src/index.js` expone:

| Endpoint | Descripción |
|----------|-------------|
| `GET /api/sensores` | Metadata de todos los sensores activos |
| `GET /api/ultimas` | Última lectura de cada sensor |
| `GET /api/historico/:sensor_index?range=24h\|7d\|30d` | Historial de un sensor, filtrado por ventana de tiempo real (no por cantidad de filas) |
| `POST /api/ingest-ahora` | Dispara una corrida de ingesta manual de PurpleAir. Requiere header `X-Ingest-Key` con el secret `INGEST_KEY` — sin la clave correcta devuelve 401 |
| `POST /api/ingest-ahora-airgradient` | Dispara una corrida de ingesta manual de AirGradient. Mismo esquema de auth que el endpoint anterior |

## Proyecto educativo

Red de sensores PurpleAir instalada en escuelas y jardines de infantes de Saladillo, con fines de monitoreo ambiental y educación ambiental ciudadana.
Ing. Luciano Lamaita — docente de Física y Química en Saladillo, Buenos Aires — más proyectos y materiales en [profe.lemeit.ar](https://profe.lemeit.ar)

## Roadmap / bitácora de ideas

Ideas pendientes de evaluar e implementar, anotadas para no perderlas entre sesiones:

- ~~**Selector de parámetros en la pestaña "Gráfico"**~~ — implementado: checkboxes para elegir qué parámetros graficar superpuestos (PM2.5, PM1.0, PM10, Temp, Humedad, Presión, VOC, CO2), cada uno con su propio eje Y independiente vía `yAxisID`.
- ~~**Sensores AirGradient (a futuro)**~~ — implementado en agosto 2026: ver "Integración AirGradient" arriba. Sigue pendiente instalar en su ubicación definitiva el segundo sensor de Saladillo (kit DIY) y, más adelante, evaluar sumar un monitor **Clarity Node-S** (solar, transmisión celular) con el mismo esquema `proveedor`/`serial_externo` ya armado para AirGradient.
- **Nombres institucionales para los sensores AirGradient**: hoy `institucion` queda en `NULL` para ambos (el dashboard cae al `locationName` crudo de AirGradient, ej. "84fce606ed88_Saladillo_Centro"). Cosmético, no bloquea nada — actualizar a mano en la tabla `sensores` cuando haya tiempo.
- **Logos de atribución (OpenAQ, PurpleAir, AirGradient)**: sumar los logos de las redes/programas de los que el autor participa en los tres portales hermanos (posiblemente en el footer compartido `lemeit-common.js` y/o en la sección "Acerca de" de cada uno), y reflejarlo también en los proyectos correspondientes de profe.lemeit.ar. Pendiente, sin apuro.
- **Simplificar la triple redundancia de ingesta**: hoy corren tres disparadores en paralelo (Cloudflare, GitHub Actions, cron-job.org) porque el Cron Trigger de Cloudflare quedó registrado pero sin disparar nunca `scheduled()` — ver "Historia de la ingesta automática" arriba. Revisar de tanto en tanto la pestaña Observability del Worker; si el Cron Trigger empieza a aparecer ahí disparando con éxito, evaluar sacar GitHub Actions y/o cron-job.org para volver a un solo camino. No hay apuro — los tres conviven sin duplicar datos.

## Contexto institucional y proyectos futuros

Notas para retomar en próximas sesiones de desarrollo (no son parte de la funcionalidad actual del dashboard):

- Este proyecto se enmarca en una iniciativa más amplia de ciencia ciudadana ambiental — *Ciencia Ciudadana Ambiental: Escuelas de Saladillo en Acción por un Aire Limpio* — que busca desplegar sensores de bajo costo dentro y cerca de instituciones educativas urbanas y rurales del partido de Saladillo, involucrando a los estudiantes en el monitoreo, el análisis de datos y la concientización comunitaria, con la mira puesta en aportar información de base para eventuales ordenanzas municipales de calidad del aire.
- El autor (Ing. Luciano Lamaita, Ing. Químico) es Embajador Comunitario de OpenAQ (2023), integra el Grupo de Trabajo de Air Quality de la ECSA (European Citizen Science Association) y participa de los proyectos CanAirIO, AireCiudadano y Sensor.Community — de ahí surgen buena parte de los antecedentes técnicos y metodológicos, incluyendo la experiencia nacional de ciencia ciudadana ambiental del Ministerio de Ambiente y Desarrollo Sustentable de la Nación, el PNUD y la iniciativa open-seneca (Universidad de Cambridge), con mediciones previas en CABA, Rosario, Mendoza, Córdoba y Tucumán (2019–2021).
- El autor trabajó anteriormente en el **Ministerio de Ambiente de la Provincia de Buenos Aires**, y mantiene buena sinergia y contacto con el **CEMCA** (Centro de Monitoreo de Calidad de Aire — panel público en [apps.ambiente.gba.gob.ar/cemca](https://apps.ambiente.gba.gob.ar/cemca/)), un área de ese mismo Ministerio, con intención de seguir trabajando en conjunto a futuro. El panel del CEMCA se usó como referencia de diseño para el mapa de `aq.lemeit.ar` (selector de contaminante/capa de datos, mapa de estaciones).
- Hay planes de integrar proyectos en conjunto con el CEMCA/Min. de Ambiente PBA a futuro, mencionados como ejemplo: **colocation de sensores de bajo costo** (instalar sensores PurpleAir junto a estaciones oficiales certificadas para comparar/calibrar contra el equipo de referencia).
- Al retomar este tema, conviene revisar si hay wiki, contactos o documentación adicional que el autor quiera sumar antes de planificar la integración técnica (autenticación, formato de datos a compartir, etc.).

## Licencia

Datos: cortesía de la red comunitaria de sensores [PurpleAir](https://www.purpleair.com), uso educativo/informativo.
Código: MIT.
