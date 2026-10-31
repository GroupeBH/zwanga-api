"""Run the real Squid binary from an extracted package, without installation.

Only loopback listeners and denied requests. Provider DNS names are mapped to
loopback in a private hosts file to test DNS-to-private-IP rejection safely.
Usage: python3 check_squid.py /absolute/path/to/extracted-package-root
"""
import grp
import os
from pathlib import Path
import pwd
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time

from jinja2 import Environment, StrictUndefined

BASE = Path(__file__).resolve().parents[1]


def request(port, method, target):
    with socket.create_connection(("127.0.0.1", port), timeout=3) as connection:
        connection.settimeout(3)
        connection.sendall(f"{method} {target} HTTP/1.1\r\nHost: {target}\r\nConnection: close\r\n\r\n".encode())
        response = b""
        while b"\r\n" not in response:
            part = connection.recv(1024)
            if not part:
                break
            response += part
    return response.split(b"\r\n", 1)[0].split()[1]


class Parent(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(3)
        data = b""
        while b"\r\n\r\n" not in data and len(data) < 4096:
            chunk = self.request.recv(1024)
            if not chunk:
                return
            data += chunk
        if not data.startswith(b"CONNECT valuesms.ae:443 "):
            self.request.sendall(b"HTTP/1.1 403 Forbidden\r\n\r\n")
            return
        self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        try:
            self.request.recv(1024)
        except OSError:
            pass


def main(root):
    with socketserver.ThreadingTCPServer(("127.0.0.1", 0), Parent) as parent:
        parent.daemon_threads = True
        thread = threading.Thread(target=parent.serve_forever, daemon=True)
        thread.start()
        try:
            checks(root, parent.server_address[1])
        finally:
            parent.shutdown()
            thread.join(timeout=3)


def checks(root, parent_port):
    binary = root / "usr/sbin/squid"
    with socket.socket() as port_probe:
        port_probe.bind(("127.0.0.1", 0))
        port = port_probe.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix="zwanga-squid-test-") as temporary:
        directory = Path(temporary)
        config = Environment(undefined=StrictUndefined).from_string(
            (BASE / "ansible/templates/squid.conf.j2").read_text()
        ).render(proxy_config={"private_ip": "127.0.0.2", "vpc_cidr": "127.0.0.0/8"})
        config = config.replace(":3128", f":{port}").replace("/var/log/squid/", f"{directory}/")
        config += f"\npid_filename {directory}/squid.pid\n"
        config += f"mime_table {root}/usr/share/squid/mime.conf\n"
        config += f"icon_directory {root}/usr/share/squid/icons\n"
        config += f"unlinkd_program {root}/usr/lib/squid/unlinkd\n"
        config += f"error_directory {root}/usr/share/squid/errors/templates\n"
        config += f"cache_effective_user {pwd.getpwuid(os.getuid()).pw_name}\n"
        config += f"cache_effective_group {grp.getgrgid(os.getgid()).gr_name}\n"
        config += f"hosts_file {directory}/hosts\n"
        # Force EVERY permitted tunnel through our owned loopback test parent.
        # The TEST-NET address is used only by ACL evaluation, never contacted.
        config += f"cache_peer 127.0.0.1 parent {parent_port} 0 no-query default\n"
        config += "never_direct allow all\n"
        # No external DNS queries or network access needed for these tests.
        config += "dns_nameservers 127.0.0.1\n"
        (directory / "hosts").write_text("192.0.2.10 valuesms.ae\n127.0.0.1 mshastra.com\n")
        (directory / "squid.conf").write_text(config)
        environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
                       "LD_LIBRARY_PATH": str(root / "usr/lib/x86_64-linux-gnu")}
        command = [str(binary), "-N", "-f", str(directory / "squid.conf")]
        with (directory / "process.log").open("w+") as log:
            process = subprocess.Popen(command, env=environment, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise RuntimeError("Squid stopped during startup")
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                            break
                    except OSError:
                        time.sleep(0.05)
                else:
                    raise RuntimeError("Squid did not become ready within 30 seconds")
                cases = [
                    ("CONNECT", "example.invalid:443"),
                    ("CONNECT", "valuesms.ae:80"),
                    ("CONNECT", "valuesms.ae.attacker.invalid:443"),
                    ("CONNECT", "169.254.169.254:443"),
                    ("CONNECT", "127.0.0.1:443"),
                    ("CONNECT", "10.42.1.5:443"),
                    ("GET", "http://valuesms.ae/"),
                    ("POST", "https://valuesms.ae/sendsms_api_json.aspx"),
                    # Legitimate hostname resolving to internal space must also fail.
                    ("CONNECT", "mshastra.com:443"),
                    ("CONNECT", "192.0.2.10:443"),
                ]
                for method, target in cases:
                    status = request(port, method, target)
                    if status != b"403":
                        raise AssertionError(f"Expected refusal: {method} {target}: {status!r}")
                status = request(port, "CONNECT", "valuesms.ae:443")
                if status != b"200":
                    raise AssertionError(f"Allowed hostname refused: {status!r}")
                print(f"Squid runtime: {len(cases)} refusals and one allowed tunnel passed, no external requests or SMS.")
            except Exception:
                log.flush(); log.seek(0)
                print(log.read()[-4000:], file=sys.stderr)
                cache_log = directory / "cache.log"
                if cache_log.exists():
                    print(cache_log.read_text()[-4000:], file=sys.stderr)
                raise
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=8)
                    except subprocess.TimeoutExpired:
                        process.kill(); process.wait(timeout=3)


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve())
