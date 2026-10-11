"""Local staging operations, invoked through the constrained SSM document.

No production credentials, automatic schema synchronization, real-user imports,
or rollback of financial migrations. Secrets never enter command output.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys

ROOT = Path("/opt/zwanga-staging")
RELEASE_PATTERN = re.compile(r"[a-f0-9]{40}")
ALLOWED_INTEGRATIONS = {
    "CORS_ORIGINS", "GOOGLE_MAPS_API_KEY", "YANDEX_MAPS_API_KEY", "OPENWEATHER_API_KEY",
    "DIDIT_OTP_API_KEY", "DIDIT_API_KEY", "DIDIT_WORKFLOW_ID", "DIDIT_WEBHOOK_SECRET",
    "DIDIT_KYC_ENABLED", "KYC_PROVIDER", "DIDIT_KYC_ARCHIVE_ENABLED", "DIDIT_KYC_MEDIA_HOSTS",
    "PAWAPAY_API_TOKEN", "PAWAPAY_DEPOSITS_ENABLED", "PAWAPAY_PAYOUTS_ENABLED",
    "PAWAPAY_REFUNDS_ENABLED", "PAWAPAY_REQUIRE_SIGNED_CALLBACKS", "PAWAPAY_REQUIRE_SIGNED_REQUESTS",
    "PAWAPAY_SIGNING_KEY_ID", "PAWAPAY_SIGNING_PRIVATE_KEY_BASE64",
    "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "LIVEKIT_ENABLED",
    "FCM_PROJECT_ID", "FCM_CLIENT_EMAIL", "FCM_PRIVATE_KEY", "FCM_CREDENTIALS_BASE64",
    "EXPO_ACCESS_TOKEN", "DRIVER_DISPATCH_ENABLED",
    "ADMIN_BOOTSTRAP_SECRET", "ADMIN_BOOTSTRAP_DEFAULT_PASSWORD", "ADMIN_BOOTSTRAP_PHONE",
    "ADMIN_BOOTSTRAP_FIRST_NAME", "ADMIN_BOOTSTRAP_LAST_NAME",
}


def validate_release(release):
    if not isinstance(release, str) or not RELEASE_PATTERN.fullmatch(release):
        raise ValueError("A full Git commit SHA is required")
    return release


def validate_config(config):
    expected = {
        "region": "eu-central-1", "domain": "staging.compute-api.zwanga-app.com",
        "registry": "046374119247.dkr.ecr.eu-central-1.amazonaws.com",
        "artifacts": "zwanga-staging-artifacts-046374119247",
        "media": "zwanga-staging-media-046374119247",
        "parameter": "/zwanga-api/staging/integrations",
    }
    if config != expected:
        raise ValueError("Host configuration is not the isolated staging configuration")


def validate_integrations(values):
    if not isinstance(values, dict) or set(values) - ALLOWED_INTEGRATIONS:
        raise ValueError("Unsupported integration settings; protected infrastructure cannot be overridden")
    if any(not isinstance(v, str) or "\x00" in v for v in values.values()):
        raise ValueError("Integration values must be strings")
    return values


def run(args, data=None, env=None, timeout=600):
    # Capture stderr too: provider/database errors can otherwise print credentials.
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            check=False, timeout=timeout, env=env)
    if result.returncode:
        raise RuntimeError("Operation failed; inspect the staging host locally (output intentionally redacted)")
    return result.stdout


def write_private(path, contents):
    temporary = path.with_suffix(path.suffix + ".next")
    temporary.write_text(contents, encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def aws(config, *args):
    return run(["aws", *args, "--region", config["region"], "--no-cli-pager"])


def compose(*args, data=None, env=None):
    return run(["docker", "compose", "-p", "zwanga-staging", "-f", str(ROOT / "compose.json"), *args], data, env)


def escape_compose(value):
    # Compose interpolates even JSON strings. $$ preserves literal provider keys.
    if isinstance(value, str):
        return value.replace("$", "$$")
    if isinstance(value, dict):
        return {k: escape_compose(v) for k, v in value.items()}
    if isinstance(value, list):
        return [escape_compose(v) for v in value]
    return value


def api_environment(config, credentials, integrations, owner=False):
    validate_integrations(integrations)
    role = "owner" if owner else "app"
    env = {
        "NODE_ENV": "production", "APP_ENV": "staging", "HOST": "0.0.0.0", "PORT": "5200",
        "API_PREFIX": "api/v1", "TYPEORM_SYNCHRONIZE": "false", "LOG_LEVEL": "warn",
        "DATABASE_URL": f"postgresql://staging_{role}:{credentials[role]}@postgres:5432/zwanga_staging?sslmode=disable",
        "REDIS_URL": f"redis://:{credentials['redis']}@redis:6379", "REDIS_TLS": "false",
        "JWT_SECRET": credentials["jwt"], "JWT_REFRESH_SECRET": credentials["refresh"],
        "AWS_REGION": config["region"], "AWS_S3_BUCKET_NAME": config["media"],
        "AWS_REKOGNITION_ENABLED": "false", "AWS_REKOGNITION_KYC_ENABLED": "false",
        "PUBLIC_API_BASE_URL": f"https://{config['domain']}",
        "CORS_ORIGINS": "http://localhost:3000,http://localhost:5173",
        "OTP_PROVIDER": "didit", "DIDIT_OTP_CHANNEL": "whatsapp",
        "KYC_PROVIDER": "legacy", "DIDIT_KYC_ENABLED": "false", "DIDIT_KYC_ARCHIVE_ENABLED": "false",
        "DIDIT_KYC_ARCHIVE_RETENTION_DAYS": "0", "DIDIT_WEBHOOK_REQUIRE_SIGNATURE": "true",
        "PAWAPAY_API_BASE_URL": "https://api.sandbox.pawapay.io",
        "PAWAPAY_CALLBACK_BASE_URL": f"https://{config['domain']}/api/v1",
        "PAWAPAY_DEPOSITS_ENABLED": "false", "PAWAPAY_PAYOUTS_ENABLED": "false",
        "PAWAPAY_REFUNDS_ENABLED": "false", "PAYMENT_ENABLED_PROVIDERS": "pawapay",
        "PAYMENT_PRIMARY_PROVIDER": "pawapay", "FLEXPAY_TOKEN": "", "FLEX_PAIE_TOKEN": "",
        "FLEXPAY_CALLBACK_BASE_URL": f"https://{config['domain']}/api/v1",
    }
    return {**env, **integrations}


def configuration(config, credentials, integrations, release):
    validate_release(release)
    image = f"{config['registry']}/zwanga-api-staging-backend:{release}"
    logging = {"driver": "json-file", "options": {"max-size": "10m", "max-file": "3"}}
    common = {"restart": "no", "logging": logging}
    # Explicit starts through systemd/SSM prevent an old API auto-restarting after
    # failed migrations. Docker itself is not the deployment state machine.
    api = {**common, "image": image, "mem_limit": "1536m", "ports": ["127.0.0.1:5200:5200"],
           "environment": api_environment(config, credentials, integrations),
           "volumes": ["uploads:/app/uploads"],
           "depends_on": {"postgres": {"condition": "service_healthy"}, "redis": {"condition": "service_healthy"}}}
    return escape_compose({"services": {
        "postgres": {**common, "image": f"{config['registry']}/zwanga-api-staging-postgres:{release}",
            "mem_limit": "1g", "environment": {"POSTGRES_PASSWORD": credentials["admin"], "POSTGRES_DB": "zwanga_staging"},
            "volumes": ["postgres:/var/lib/postgresql"],
            "healthcheck": {"test": ["CMD-SHELL", "pg_isready -U postgres -d zwanga_staging"], "interval": "5s", "timeout": "5s", "retries": 30}},
        "redis": {**common, "image": "valkey/valkey:7.2.6-alpine", "mem_limit": "256m",
            "command": ["valkey-server", "--appendonly", "yes", "--requirepass", credentials["redis"], "--maxmemory", "128mb", "--maxmemory-policy", "noeviction"],
            "environment": {"VALKEYCLI_AUTH": credentials["redis"]}, "volumes": ["redis:/data"],
            "healthcheck": {"test": ["CMD", "valkey-cli", "ping"], "interval": "5s", "timeout": "5s", "retries": 10}},
        "api": api,
        "migrate": {**common, "image": image, "mem_limit": "1024m", "profiles": ["tools"],
            "environment": api_environment(config, credentials, integrations, owner=True)},
        "proxy": {**common, "image": "caddy:2.10.2-alpine", "mem_limit": "128m", "ports": ["80:80", "443:443"],
            "volumes": [f"{ROOT}/Caddyfile:/etc/caddy/Caddyfile:ro", "caddy_data:/data", "caddy_config:/config"],
            "depends_on": {"api": {"condition": "service_healthy"}}},
    }, "volumes": {v: {} for v in ["postgres", "redis", "uploads", "caddy_data", "caddy_config"]}})


def sql(query, credentials, owner=False):
    role = "staging_owner" if owner else "postgres"
    env = {**os.environ, "PGPASSWORD": credentials["owner" if owner else "admin"]}
    return compose("exec", "-T", "-e", "PGPASSWORD", "postgres", "psql", "-X", "-h", "127.0.0.1",
                   "-U", role, "-d", "zwanga_staging", "-v", "ON_ERROR_STOP=1", "-At", data=query.encode(), env=env)


def prepare_database(credentials):
    # Passwords are locally generated hex, never accepted as SQL from SSM.
    for role in ("app", "owner"):
        if not re.fullmatch(r"[a-f0-9]{64}", credentials[role]):
            raise ValueError("Invalid local credential")
        sql(f"SELECT 'CREATE ROLE staging_{role} LOGIN PASSWORD ''{credentials[role]}'' NOSUPERUSER NOCREATEDB NOCREATEROLE' "
            f"WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='staging_{role}')\\gexec\n", credentials)
    sql('ALTER DATABASE zwanga_staging OWNER TO staging_owner;\n'
        'REVOKE CREATE ON SCHEMA public FROM PUBLIC;\n'
        'GRANT USAGE, CREATE ON SCHEMA public TO staging_owner;\n'
        'CREATE EXTENSION IF NOT EXISTS postgis;\n'
        'CREATE EXTENSION IF NOT EXISTS pgcrypto;\n'
        'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";\n', credentials)


def grants(credentials):
    sql('BEGIN; SET LOCAL lock_timeout=\'5s\'; SET LOCAL statement_timeout=\'30s\'; '
        'GRANT USAGE ON SCHEMA public TO staging_app; '
        'GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO staging_app; '
        'GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO staging_app; '
        'ALTER DEFAULT PRIVILEGES FOR ROLE staging_owner IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO staging_app; '
        'ALTER DEFAULT PRIVILEGES FOR ROLE staging_owner IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO staging_app; COMMIT;', credentials)


def validate_manifest(manifest, archive):
    validate_release(manifest.get("baselineCommit"))
    if manifest.get("schemaSha256") != hashlib.sha256(archive).hexdigest():
        raise ValueError("Schema checksum does not match reviewed manifest")
    if type(manifest.get("financialPolicyEnabled")) is not bool:
        raise ValueError("Manifest must explicitly choose the test financial policy")
    migrations = manifest.get("migrations")
    if not isinstance(migrations, list) or not migrations:
        raise ValueError("Baseline migration history is required")
    seen = set()
    for row in migrations:
        if (type(row.get("timestamp")) is not int or row["timestamp"] <= 0
                or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", row.get("name", ""))
                or row["name"] in seen):
            raise ValueError("Invalid baseline migration history")
        seen.add(row["name"])
    return migrations


def bootstrap(config, credentials):
    if (ROOT / "database-ready").exists():
        raise ValueError("Database already initialized; no overwrite permitted")
    # An extension-owned spatial_ref_sys table is expected; no application tables.
    count = sql("SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename<>'spatial_ref_sys';", credentials)
    if count.strip() != b"0":
        raise ValueError("Bootstrap requires an empty database; inspect partial imports manually")
    archive = aws(config, "s3", "cp", f"s3://{config['artifacts']}/bootstrap/schema.dump", "-", "--only-show-errors")
    manifest = json.loads(aws(config, "s3", "cp", f"s3://{config['artifacts']}/bootstrap/manifest.json", "-", "--only-show-errors"))
    migrations = validate_manifest(manifest, archive)
    listing = compose("exec", "-T", "postgres", "pg_restore", "--list", data=archive).decode()
    if re.search(r"\b(TABLE DATA|MATERIALIZED VIEW DATA|SEQUENCE SET|BLOB|LARGE OBJECT)\b", listing):
        raise ValueError("Only a schema-only archive is accepted; no user data")
    # pg_dump --schema=public includes CREATE SCHEMA public. Keep the existing
    # schema and preinstalled extensions; omit ONLY that TOC entry, never DROP it.
    restore_list = "\n".join(line for line in listing.splitlines()
                             if not re.match(r"^\d+;\s+\d+\s+\d+\s+SCHEMA\s+-\s+public(?:\s|$)", line)) + "\n"
    write_private(ROOT / "restore.list", restore_list)
    compose("cp", str(ROOT / "restore.list"), "postgres:/tmp/zwanga-staging-restore.list")
    write_private(ROOT / "deployment-blocked", "Bootstrap in progress")
    compose("exec", "-T", "-e", "PGPASSWORD", "postgres", "pg_restore", "-h", "127.0.0.1",
            "-U", "staging_owner", "-d", "zwanga_staging", "--schema-only", "--no-owner", "--no-privileges",
            "--no-comments", "--exit-on-error", "--single-transaction",
            "--use-list=/tmp/zwanga-staging-restore.list", data=archive,
            env={**os.environ, "PGPASSWORD": credentials["owner"]})
    entries = ",".join(f"({row['timestamp']},'{row['name']}')" for row in migrations)
    enabled = "true" if manifest["financialPolicyEnabled"] else "false"
    sql("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'; "
        f'INSERT INTO typeorm_migrations (timestamp,name) VALUES {entries}; '
        f'INSERT INTO financial_rollout (id,enabled,"activatedAt") VALUES (true,{enabled},'
        f"CASE WHEN {enabled} THEN now() ELSE NULL END); COMMIT;", credentials, owner=True)
    grants(credentials)
    write_private(ROOT / "database-ready", json.dumps({"baselineCommit": manifest["baselineCommit"]}))
    # Keep deployment-blocked until a migration + health-checked deployment succeeds.


def main(action, release=None):
    import fcntl
    os.umask(0o077)
    if action not in {"deploy", "bootstrap", "resume", "status"}:
        raise ValueError("Unsupported action")
    config = json.loads((ROOT / "config.json").read_text())
    validate_config(config)
    with (ROOT / "operation.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if action == "status":
            print(json.dumps({"databaseReady": (ROOT / "database-ready").exists(),
                              "blocked": (ROOT / "deployment-blocked").exists(),
                              "hasRelease": (ROOT / "last-release.json").exists()}))
            return
        if action == "resume":
            if (ROOT / "deployment-blocked").exists():
                raise ValueError("Previous deployment failed; automatic restart blocked")
            release = json.loads((ROOT / "last-release.json").read_text())["release"]
        validate_release(release)
        if not (ROOT / "secrets.json").exists():
            write_private(ROOT / "secrets.json", json.dumps({k: secrets.token_hex(32) for k in ["admin", "owner", "app", "redis", "jwt", "refresh"]}))
        credentials = json.loads((ROOT / "secrets.json").read_text())
        integrations = json.loads(json.loads(aws(config, "ssm", "get-parameter", "--name", config["parameter"], "--with-decryption"))["Parameter"]["Value"])
        spec = configuration(config, credentials, integrations, release)
        # Validate all inputs before stopping an existing API.
        if action in {"deploy", "bootstrap"} and (ROOT / "compose.json").exists():
            compose("stop", "proxy", "api")
        write_private(ROOT / "compose.json", json.dumps(spec))
        if not (ROOT / "Caddyfile").is_file():
            raise ValueError("Ansible must configure the Caddy reverse proxy first")
        token = aws(config, "ecr", "get-login-password")
        run(["docker", "login", "--username", "AWS", "--password-stdin", config["registry"]], token)
        compose("pull", "postgres", "redis", "api", "proxy")
        compose("up", "-d", "--wait", "--wait-timeout", "180", "postgres", "redis")
        prepare_database(credentials)
        if action == "bootstrap":
            bootstrap(config, credentials)
            print("Schema-only staging bootstrap complete. Run deploy next.")
            return
        if not (ROOT / "database-ready").exists():
            raise ValueError("Reviewed schema-only bootstrap required before deployment")
        if action == "deploy":
            write_private(ROOT / "deployment-blocked", "Deployment in progress; do not resume an old API")
            # Local pre-migration backup, never copied to production. Retained for recovery.
            backup = compose("exec", "-T", "postgres", "pg_dump", "-U", "postgres", "-d", "zwanga_staging", "-Fc")
            backup_dir = ROOT / "backups"
            backup_dir.mkdir(exist_ok=True, mode=0o700)
            (backup_dir / f"before-{release}.dump").write_bytes(backup)
            compose("run", "--rm", "--no-deps", "migrate", "sh", "-c",
                    "npm run database:assert-bootstrap:prod && npm run migration:run:prod")
            grants(credentials)
        compose("up", "-d", "--wait", "--wait-timeout", "240", "api", "proxy")
        write_private(ROOT / "last-release.json", json.dumps({"release": release}))
        if (ROOT / "deployment-blocked").exists():
            (ROOT / "deployment-blocked").unlink()
        print("Staging API healthy on the host; HTTPS must be verified by the workflow.")


if __name__ == "__main__":
    try:
        main(*sys.argv[1:])
    except Exception as error:
        # Neither subprocess output, SQL, SSM values nor provider errors in CI logs.
        print(f"Staging operation failed ({type(error).__name__}). Check host state and protected local configuration.", file=sys.stderr)
        sys.exit(1)
