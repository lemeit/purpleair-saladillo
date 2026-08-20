-- Migración: agrega columnas de canal A y B (necesarias para overlay en el chart
-- y para detectar divergencia entre canales / sensores degradados)
ALTER TABLE lecturas ADD COLUMN pm2_5_a REAL;
ALTER TABLE lecturas ADD COLUMN pm2_5_b REAL;
