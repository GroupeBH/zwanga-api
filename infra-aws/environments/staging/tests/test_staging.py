import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

BASE = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runtime = load("runtime", BASE / "host/runtime.py")
with patch.dict(sys.modules, {"boto3": MagicMock()}):
    control = load("handler", BASE / "control/handler.py")

CONFIG = {
    "region": "eu-central-1", "domain": "staging.compute-api.zwanga-app.com",
    "registry": "046374119247.dkr.ecr.eu-central-1.amazonaws.com",
    "artifacts": "zwanga-staging-artifacts-046374119247",
    "media": "zwanga-staging-media-046374119247",
    "parameter": "/zwanga-api/staging/integrations",
}
CREDS = {key: "a" * 64 for key in ["admin", "owner", "app", "redis", "jwt", "refresh"]}
SHA = "1" * 40


class RuntimeTests(unittest.TestCase):
    def test_pinned_configuration(self):
        runtime.validate_config(CONFIG)
        for key in CONFIG:
            with self.subTest(key=key), self.assertRaises(ValueError):
                runtime.validate_config({**CONFIG, key: "production"})

    def test_release_injection_rejected(self):
        for value in ["latest", "release", "1" * 39, "a; shutdown", "../production", None]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                runtime.validate_release(value)

    def test_infrastructure_cannot_be_overridden_in_ssm(self):
        for key in ["DATABASE_URL", "JWT_SECRET", "AWS_S3_BUCKET_NAME", "AWS_ACCESS_KEY_ID",
                    "PAWAPAY_API_BASE_URL", "FLEXPAY_TOKEN", "PUBLIC_API_BASE_URL", "NODE_ENV"]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                runtime.validate_integrations({key: "production"})

    def test_integrations_require_strings(self):
        for value in [[], {"DIDIT_API_KEY": False}, {"DIDIT_API_KEY": "\x00"}]:
            with self.assertRaises(ValueError):
                runtime.validate_integrations(value)

    def test_test_providers_supported(self):
        values = {"DIDIT_OTP_API_KEY": "test", "PAWAPAY_DEPOSITS_ENABLED": "true"}
        self.assertEqual(runtime.validate_integrations(values), values)

    def test_compose_isolation_and_versions(self):
        spec = runtime.configuration(CONFIG, CREDS, {}, SHA)
        services = spec["services"]
        self.assertNotIn("ports", services["postgres"])
        self.assertNotIn("ports", services["redis"])
        self.assertEqual(services["api"]["ports"], ["127.0.0.1:5200:5200"])
        self.assertEqual(services["redis"]["image"], "valkey/valkey:7.2.6-alpine")
        for service in services.values():
            self.assertEqual(service["restart"], "no")
        env = services["api"]["environment"]
        self.assertEqual(env["TYPEORM_SYNCHRONIZE"], "false")
        self.assertIn("staging_app:", env["DATABASE_URL"])
        self.assertIn("staging_owner:", services["migrate"]["environment"]["DATABASE_URL"])
        self.assertEqual(env["PAYMENT_ENABLED_PROVIDERS"], "pawapay")
        self.assertEqual(env["PAWAPAY_API_BASE_URL"], "https://api.sandbox.pawapay.io")
        self.assertEqual(env["DIDIT_KYC_ENABLED"], "false")

    def test_compose_does_not_interpolate_credentials(self):
        spec = runtime.configuration(CONFIG, CREDS, {"DIDIT_API_KEY": "foo${BAR}$baz"}, SHA)
        self.assertEqual(spec["services"]["api"]["environment"]["DIDIT_API_KEY"], "foo$${BAR}$$baz")

    def test_reviewed_bootstrap_manifest(self):
        archive = b"test schema"
        manifest = {"baselineCommit": SHA, "schemaSha256": hashlib.sha256(archive).hexdigest(),
                    "financialPolicyEnabled": True,
                    "migrations": [{"timestamp": 1780000064000, "name": "AddPinResetReplayProtection1780000064000"}]}
        self.assertEqual(runtime.validate_manifest(manifest, archive), manifest["migrations"])
        for key, value in [("schemaSha256", "wrong"), ("financialPolicyEnabled", "true"),
                           ("migrations", []), ("migrations", [{"timestamp": 1, "name": "bad');DROP"}]),
                           ("migrations", manifest["migrations"] * 2)]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                runtime.validate_manifest({**manifest, key: value}, archive)

    @patch.object(runtime.subprocess, "run")
    def test_subprocess_errors_do_not_leak_secrets(self, execute):
        execute.return_value = MagicMock(returncode=1, stderr=b"password=VERY_SECRET")
        with self.assertRaises(RuntimeError) as caught:
            runtime.run(["test"])
        self.assertNotIn("VERY_SECRET", str(caught.exception))

    def test_production_not_imported_as_module(self):
        terraform = (BASE / "main.tf").read_text()
        self.assertNotIn('source = "../.."', terraform)
        for forbidden in ["aws_db_instance", "aws_elasticache", 'resource "aws_lb"', "aws_nat_gateway", 'resource "aws_eip"']:
            self.assertNotIn(forbidden, terraform)


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"INSTANCE_ID": "i-test", "HOSTED_ZONE": "ZTEST", "DOMAIN": CONFIG["domain"]})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.ec2 = MagicMock()
        self.dns = MagicMock()
        self.clients = patch.object(control.boto3, "client", side_effect=lambda name: {"ec2": self.ec2, "route53": self.dns}[name])
        self.clients.start()
        self.addCleanup(self.clients.stop)
        self.instance = {"State": {"Name": "running"}, "LaunchTime": datetime.now(timezone.utc) - timedelta(minutes=10),
                         "PublicIpAddress": "203.0.113.10",
                         "Tags": [{"Key": "Environment", "Value": "staging"}, {"Key": "Name", "Value": "zwanga-api-staging"}]}
        self.ec2.describe_instances.return_value = {"Reservations": [{"Instances": [self.instance]}]}

    def call(self, action):
        return control.handler({"action": action}, None)

    def dns_address(self):
        return self.dns.change_resource_record_sets.call_args.kwargs["ChangeBatch"]["Changes"][0]["ResourceRecordSet"]["ResourceRecords"][0]["Value"]

    def test_start_stopped_instance(self):
        self.instance["State"]["Name"] = "stopped"
        result = self.call("start")
        self.assertEqual(result["state"], "pending")
        self.ec2.start_instances.assert_called_once_with(InstanceIds=["i-test"])
        self.assertEqual(self.dns_address(), "0.0.0.0")

    def test_running_start_does_not_extend_session(self):
        result = self.call("start")
        self.ec2.start_instances.assert_not_called()
        self.assertLess(result["remainingSeconds"], 6601)
        self.assertEqual(self.dns_address(), "203.0.113.10")

    def test_watchdog_stops_expired_instance(self):
        self.instance["LaunchTime"] = datetime.now(timezone.utc) - timedelta(hours=2, seconds=1)
        result = self.call("watchdog")
        self.assertTrue(result["expired"])
        self.ec2.stop_instances.assert_called_once_with(InstanceIds=["i-test"])
        self.assertEqual(self.dns_address(), "0.0.0.0")

    def test_manual_stop(self):
        self.call("stop")
        self.ec2.stop_instances.assert_called_once()

    def test_stopped_instance_does_not_restart_on_watchdog(self):
        self.instance["State"]["Name"] = "stopped"
        self.call("watchdog")
        self.ec2.start_instances.assert_not_called()
        self.ec2.stop_instances.assert_not_called()
        self.assertEqual(self.dns_address(), "0.0.0.0")

    def test_stop_even_if_dns_fails(self):
        self.dns.change_resource_record_sets.side_effect = RuntimeError("DNS unavailable")
        with self.assertRaises(RuntimeError):
            self.call("stop")
        self.ec2.stop_instances.assert_called_once()

    def test_production_tags_rejected(self):
        self.instance["Tags"][0]["Value"] = "production"
        with self.assertRaises(ValueError):
            self.call("stop")
        self.ec2.stop_instances.assert_not_called()

    def test_invalid_action_rejected(self):
        with self.assertRaises(ValueError):
            self.call("destroy")
        self.ec2.describe_instances.assert_not_called()


if __name__ == "__main__":
    unittest.main()
