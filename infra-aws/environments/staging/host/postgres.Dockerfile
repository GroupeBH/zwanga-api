# postgis/postgis is amd64-only. Build the official PostgreSQL ARM64 image
# with official PGDG PostGIS packages in CI, never on the small test server.
FROM postgres:18.3-trixie
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-18-postgis-3 postgresql-18-postgis-3-scripts \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
