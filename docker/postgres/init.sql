-- Initialisation de PostGIS pour PostgreSQL
-- Ce script s'exécute automatiquement lors de la première création du conteneur

-- Activer l'extension PostGIS
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;

-- Vérifier l'installation
SELECT PostGIS_version();

