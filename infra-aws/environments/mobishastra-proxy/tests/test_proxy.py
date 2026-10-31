import importlib.util
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch

BASE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("proxy_health", BASE / "host/health.py")
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)


class ProxyTests(unittest.TestCase):
    def probe(self, response):
        connection = MagicMock()
        connection.__enter__.return_value = connection
        connection.recv.side_effect = response
        with patch.object(health.socket, "create_connection", return_value=connection) as connect:
            result = health.healthy()
        connect.assert_called_once_with(("127.0.0.1", 3128), timeout=3)
        self.assertNotIn(b"sendsms", connection.sendall.call_args[0][0])
        return result

    def test_local_denial_is_healthy(self):
        self.assertTrue(self.probe([b"HTTP/1.1 403 Forbidden\r\n"]))

    def test_fragmented_response(self):
        self.assertTrue(self.probe([b"HTTP/1.", b"0 403 Forbidden\r\n"]))

    def test_insecure_or_failed_proxy(self):
        for response in [b"HTTP/1.1 200 OK\r\n", b"HTTP/1.1 503 Failure\r\n", b"", b"garbage\r\n"]:
            with self.subTest(response=response):
                self.assertFalse(self.probe([response, b""]))

    def test_connection_failure(self):
        with patch.object(health.socket, "create_connection", side_effect=OSError):
            self.assertFalse(health.healthy())

    def test_no_production_routes_service_or_secrets_owned_by_this_root(self):
        terraform = "\n".join(path.read_text() for path in BASE.glob("*.tf"))
        for resource in ["aws_route", "aws_route_table", "aws_ecs_service", "aws_ecs_task_definition", "aws_ssm_parameter", "aws_lb", "aws_nat_gateway"]:
            self.assertNotIn(f'resource "{resource}"', terraform)
        self.assertIn('key                 = "zwanga/mobishastra-proxy/terraform.tfstate"', terraform)
        self.assertGreaterEqual(terraform.count("prevent_destroy = true"), 2)

    def test_deny_rules_precede_allow_and_no_tls_interception(self):
        config = (BASE / "ansible/templates/squid.conf.j2").read_text()
        for rule in ["!tunnel", "!tls_port", "!mobishastra", "forbidden_dst"]:
            self.assertLess(config.index(f"http_access deny {rule}"), config.index("http_access allow backend"))
        self.assertIn("http_access deny all", config)
        self.assertIn("dstdomain -n valuesms.ae mshastra.com", config)
        self.assertNotIn("ssl_bump", config)
        self.assertNotIn("%ru", config)
        self.assertNotIn("%>h", config)
        self.assertIn("169.254.0.0/16", config)


if __name__ == "__main__":
    unittest.main()
