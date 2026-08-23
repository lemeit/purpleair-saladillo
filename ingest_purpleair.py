"""
Consulta la API de PurpleAir para los sensores propios y guarda cada lectura
en Cloudflare D1 vía su API HTTP.

Variables de entorno requeridas (se cargan como secrets en GitHub Actions):
    PURPLEAIR_API_KEY   -> API key de lectura de develop.purpleair.com
    SENSOR_INDEXES      -> lista separada por comas, ej: "12345,67890"
    CF_ACCOUNT_ID       -> Account ID de Cloudflare
    CF_DATABASE_ID      -> database_id que devolvió `wrangler d1 create`
    CF_API_TOKEN        -> API token de Cloudflare con permiso D1:Edit
"""

import os
import sys
import requests

PURPLEAIR_API_KEY = os.environ["PURPLEAIR_API_KEY"]
SENSOR_INDEXES = os.environ["SENSOR_INDEXES"]  # ej: "12345,67890"
CF_ACCOUNT_ID = os.environ["CF_ACCOUNT_ID"]
CF_DATABASE_ID = os.environ["CF_DATABASE_ID"]
CF_API_TOKEN = os.environ["CF_API_TOKEN"]

FIELDS = (
    "name,latitude,longitude,pm1.0,pm2.5,pm2.5_10minute,pm2.5_60minute,pm10.0,"
    "pm2.5_a,pm2.5_b,pm1.0_a,pm1.0_b,pm10.0_a,pm10.0_b,voc,"
    "temperature,humidity,pressure,rssi,last_seen"
)
# voc = índice VOC (Bosch BME68x), promedio de canal A y B, en unidades IAQ
# estáticas de Bosch (EXPERIMENTAL según la documentación de PurpleAir).
# Solo lo reportan sensores PurpleAir Flex/Zen/Touch, o un Classic/Classic-SD
# con el chip BME688 (upgrade de hardware). En los PA-II/PA-II-SD estándar
# (BME280, sin sensor de gas) la API devuelve null para ese campo — no es un
# error, esos sensores simplemente no tienen hardware de gas.
#
# NOTA: el nombre de campo "gas_680" (usado en una versión anterior de este
# script) NO es válido en la API v1 actual — la API lo rechaza con
# 400 Bad Request / InvalidFieldValueError. El nombre correcto es "voc"
# (confirmado contra la documentación de la comunidad PurpleAir, agosto 2026).
# Existen también "voc_a"/"voc_b" para leer los canales por separado, no
# usados acá porque "voc" ya da el promedio.

D1_URL = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database/{CF_DATABASE_ID}/query"


def fahrenheit_to_celsius(temp_f):
    if temp_f is None:
        return None
    return round((temp_f - 32) * 5 / 9, 2)


def fetch_purpleair_data():
    url = "https://api.purpleair.com/v1/sensors"
    headers = {"X-API-Key": PURPLEAIR_API_KEY}
    params = {
        "fields": FIELDS,
        "show_only": SENSOR_INDEXES,
    }
    resp = requests.get(url, headers=headers, params=params, timeout=30)
    if not resp.ok:
        # Si la API rechaza el pedido (ej: un nombre de campo invalido en
        # FIELDS), esto imprime el motivo real en vez de un traceback ciego.
        print(f"Error de la API de PurpleAir ({resp.status_code}): {resp.text}")
    resp.raise_for_status()
    return resp.json()


def d1_query(sql, params_list):
    headers = {
        "Authorization": f"Bearer {CF_API_TOKEN}",
        "Content-Type": "application/json",
    }
    body = {"sql": sql, "params": params_list}
    resp = requests.post(D1_URL, headers=headers, json=body, timeout=30)
    resp.raise_for_status()
    result = resp.json()
    if not result.get("success"):
        raise RuntimeError(f"D1 query failed: {result}")
    return result


def upsert_sensor_metadata(sensor_index, nombre, lat, lon):
    sql = """
        INSERT INTO sensores (sensor_index, nombre, latitud, longitud)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(sensor_index) DO UPDATE SET
            nombre = excluded.nombre,
            latitud = excluded.latitud,
            longitud = excluded.longitud
    """
    d1_query(sql, [sensor_index, nombre, lat, lon])


def get_field(row, field_index, name):
    # Lectura "segura": si la API de PurpleAir no devolvió esta columna para
    # este sensor (campo no soportado por el hardware, nombre no reconocido,
    # etc.), guardamos NULL en vez de que reviente todo el script con un
    # KeyError/IndexError y se pierda la ingesta completa de esa corrida.
    idx = field_index.get(name)
    if idx is None or idx >= len(row):
        return None
    return row[idx]


def insert_lectura(row, field_index):
    sensor_index = get_field(row, field_index, "sensor_index")
    timestamp = get_field(row, field_index, "last_seen")

    sql = """
        INSERT INTO lecturas (
            sensor_index, timestamp, pm1_0, pm2_5, pm2_5_10min,
            pm2_5_60min, pm10_0, pm2_5_a, pm2_5_b, pm1_0_a, pm1_0_b,
            pm10_0_a, pm10_0_b, voc, temperatura, humedad, presion, rssi
        ) VALUES (?, datetime(?, 'unixepoch'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    params = [
        sensor_index,
        timestamp,
        get_field(row, field_index, "pm1.0"),
        get_field(row, field_index, "pm2.5"),
        get_field(row, field_index, "pm2.5_10minute"),
        get_field(row, field_index, "pm2.5_60minute"),
        get_field(row, field_index, "pm10.0"),
        get_field(row, field_index, "pm2.5_a"),
        get_field(row, field_index, "pm2.5_b"),
        get_field(row, field_index, "pm1.0_a"),
        get_field(row, field_index, "pm1.0_b"),
        get_field(row, field_index, "pm10.0_a"),
        get_field(row, field_index, "pm10.0_b"),
        get_field(row, field_index, "voc"),
        fahrenheit_to_celsius(get_field(row, field_index, "temperature")),
        get_field(row, field_index, "humidity"),
        get_field(row, field_index, "pressure"),
        get_field(row, field_index, "rssi"),
    ]
    d1_query(sql, params)


def main():
    data = fetch_purpleair_data()
    fields = data["fields"]
    field_index = {name: i for i, name in enumerate(fields)}
    sensor_index_col = field_index["sensor_index"]
    name_col = field_index["name"]
    lat_col = field_index["latitude"]
    lon_col = field_index["longitude"]

    if not data.get("data"):
        print("No se recibieron datos de la API de PurpleAir.")
        sys.exit(1)

    for row in data["data"]:
        sensor_index = row[sensor_index_col]
        nombre = row[name_col]
        lat = row[lat_col]
        lon = row[lon_col]

        upsert_sensor_metadata(sensor_index, nombre, lat, lon)
        insert_lectura(row, field_index)
        print(f"Guardado: sensor {sensor_index} ({nombre})")


if __name__ == "__main__":
    main()
