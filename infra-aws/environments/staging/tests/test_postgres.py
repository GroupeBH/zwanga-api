"""Opt-in throwaway PostgreSQL 18 + PostGIS tests. No app .env or AWS access.

STAGING_TEST_POSTGRES_BIN must point to locally installed PostgreSQL tools.
Only a random loopback port and a new temporary cluster are used.
"""
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from test_staging import runtime, CONFIG, SHA

BIN = os.environ.get("STAGING_TEST_POSTGRES_BIN")


@unittest.skipUnless(BIN, "Opt-in isolated PostgreSQL test")
class PostgresTests(unittest.TestCase):
    @classmethod
    def execute(cls, name, *args, data=None, env=None, check=True):
        executable = str(Path(BIN) / (name + (".exe" if os.name == "nt" else "")))
        # A Windows postmaster can inherit pg_ctl's pipe handles. Capturing those
        # pipes waits until the server exits, not until pg_ctl exits.
        output = subprocess.DEVNULL if name == "pg_ctl" else subprocess.PIPE
        result = subprocess.run([executable, *args], input=data, env=env,
                                stdout=output, stderr=output, timeout=60,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        if check and result.returncode:
            raise AssertionError((result.stderr or b"PostgreSQL control failed").decode(errors="replace"))
        return result

    @classmethod
    def setUpClass(cls):
        cls.directory = Path(tempfile.mkdtemp(prefix="zwanga-staging-pg-test-"))
        cls.started = False
        cls.addClassCleanup(cls.cleanup)
        cls.execute("initdb", "-D", str(cls.directory / "cluster"), "-U", "postgres", "-A", "trust", "--no-locale", "-E", "UTF8")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = str(sock.getsockname()[1])
        cls.started = True  # Ensure cleanup even if startup/wait fails after spawning.
        cls.execute("pg_ctl", "-D", str(cls.directory / "cluster"), "-l", str(cls.directory / "postgres.log"),
                    "-o", f"-h 127.0.0.1 -p {cls.port}", "-w", "start")
        cls.execute("createdb", "-h", "127.0.0.1", "-p", cls.port, "-U", "postgres", "zwanga_staging")
        cls.execute("createdb", "-h", "127.0.0.1", "-p", cls.port, "-U", "postgres", "source_staging")
        source_schema = b'''CREATE TABLE users(id serial PRIMARY KEY, name text);
          CREATE TABLE trips(id serial PRIMARY KEY);
          CREATE TABLE bookings(id serial PRIMARY KEY);
          CREATE TABLE typeorm_migrations(id serial PRIMARY KEY, timestamp bigint NOT NULL, name varchar NOT NULL);
          CREATE TABLE financial_rollout(id boolean PRIMARY KEY DEFAULT true, enabled boolean, "activatedAt" timestamptz);
          INSERT INTO users(name) VALUES ('DO_NOT_IMPORT');
          INSERT INTO typeorm_migrations(timestamp,name) VALUES (1780000064000,'Baseline1780000064000');
          INSERT INTO financial_rollout(id,enabled) VALUES (true,true);'''
        cls.execute("psql", "-X", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", cls.port,
                    "-U", "postgres", "-d", "source_staging", data=source_schema)
        cls.archive = cls.execute("pg_dump", "-h", "127.0.0.1", "-p", cls.port, "-U", "postgres",
                                   "-d", "source_staging", "--schema-only", "-Fc").stdout
        cls.credentials = {k: secrets.token_hex(32) for k in ["admin", "owner", "app", "redis", "jwt", "refresh"]}

    @classmethod
    def cleanup(cls):
        if cls.started:
            # Cleanup is restricted to the generated cluster, never the local main service.
            cls.execute("pg_ctl", "-D", str(cls.directory / "cluster"), "-m", "fast", "-w", "stop")
        target = cls.directory.resolve()
        if target.parent != Path(tempfile.gettempdir()).resolve() or not target.name.startswith("zwanga-staging-pg-test-"):
            raise AssertionError("Unsafe test cleanup target")
        shutil.rmtree(target)

    def compose(self, *args, data=None, env=None):
        if args[0] == "cp":
            self.restore_list = args[1]
            return b""
        for executable in ["psql", "pg_restore"]:
            if executable in args:
                options = list(args[args.index(executable) + 1:])
                options = [f"--use-list={self.restore_list}" if item == "--use-list=/tmp/zwanga-staging-restore.list" else item for item in options]
                if "--list" not in options:
                    options += ["-p", self.port]
                return self.execute(executable, *options, data=data, env=env).stdout
        raise AssertionError("Unexpected Docker operation in database test")

    def test_schema_only_bootstrap_and_least_privilege(self):
        # Exercise the actual read-only exporter against the throwaway source,
        # then use its exact artifacts for the guarded staging import.
        destination = self.directory / "export"
        exporter = Path(__file__).resolve().parents[1] / "export-baseline.cjs"
        result = subprocess.run(["node", str(exporter), str(destination), SHA],
            env={**os.environ, "STAGING_BASELINE_SOURCE_URL": f"postgresql://postgres@127.0.0.1:{self.port}/source_staging",
                 "STAGING_BASELINE_PG_DUMP": str(Path(BIN) / ("pg_dump.exe" if os.name == "nt" else "pg_dump"))},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        archive = (destination / "schema.dump").read_bytes()
        manifest = json.loads((destination / "manifest.json").read_text())
        self.assertEqual(manifest["schemaSha256"], hashlib.sha256(archive).hexdigest())
        root = self.directory / "host"
        root.mkdir()
        with patch.object(runtime, "ROOT", root), patch.object(runtime, "compose", side_effect=self.compose):
            runtime.prepare_database(self.credentials)
            runtime.prepare_database(self.credentials)  # safe after stop/start
            with patch.object(runtime, "aws", side_effect=[archive, json.dumps(manifest).encode()]):
                runtime.bootstrap(CONFIG, self.credentials)
            self.assertTrue((root / "database-ready").exists())
            self.assertTrue((root / "deployment-blocked").exists())
            self.assertEqual(runtime.sql("SELECT count(*) FROM users;", self.credentials).strip(), b"0")
            self.assertEqual(runtime.sql("SELECT count(*) FROM typeorm_migrations;", self.credentials).strip(), b"1")
            self.assertEqual(runtime.sql("SELECT enabled FROM financial_rollout;", self.credentials).strip(), b"t")
            with self.assertRaises(ValueError):
                runtime.bootstrap(CONFIG, self.credentials)
        result = self.execute("psql", "-X", "-h", "127.0.0.1", "-p", self.port, "-U", "staging_app",
                              "-d", "zwanga_staging", "-v", "ON_ERROR_STOP=1", data=b"INSERT INTO users(name) VALUES ('synthetic');")
        self.assertEqual(result.returncode, 0)
        result = self.execute("psql", "-X", "-h", "127.0.0.1", "-p", self.port, "-U", "staging_app",
                              "-d", "zwanga_staging", "-v", "ON_ERROR_STOP=1", data=b"CREATE TABLE forbidden(id int);", check=False)
        self.assertNotEqual(result.returncode, 0)
