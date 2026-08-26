-- Migration 005: Agrega columna de NOx (índice SGP41 de AirGradient)
-- Medición del sensor AirGradient (noxIndex).
-- Se define como REAL (NULL para PurpleAir o sensores AirGradient que no reporten NOx).

ALTER TABLE lecturas ADD COLUMN nox REAL;