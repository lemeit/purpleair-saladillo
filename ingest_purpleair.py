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

FIELDS = "name,latitude,longitude,pm1.0,pm2.5,pm2.5_10minute,pm2.5_60minute,pm10.0,pm2.5_a,pm2.5_b,temperature,humidity,pressure,rssi,last_seen"

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


def insert_lectura(row, field_index):
    sensor_index = row[field_index["sensor_index"]]
    timestamp = row[field_index["last_seen"]]

    sql = """
        INSERT INTO lecturas (
            sensor_index, timestamp, pm1_0, pm2_5, pm2_5_10min,
            pm2_5_60min, pm10_0, pm2_5_a, pm2_5_b, temperatura, humedad, presion, rssi
        ) VALUES (?, datetime(?, 'unixepoch'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    params = [
        sensor_index,
        timestamp,
        row[field_index["pm1.0"]],
        row[field_index["pm2.5"]],
        row[field_index["pm2.5_10minute"]],
        row[field_index["pm2.5_60minute"]],
        row[field_index["pm10.0"]],
        row[field_index["pm2.5_a"]],
        row[field_index["pm2.5_b"]],
        fahrenheit_to_celsius(row[field_index["temperature"]]),
        row[field_index["humidity"]],
        row[field_index["pressure"]],
        row[field_index["rssi"]],
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
