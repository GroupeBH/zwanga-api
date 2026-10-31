"""Local denial probe, never an SMS or an external provider call."""
import socket
import sys


def healthy():
    try:
        with socket.create_connection(("127.0.0.1", 3128), timeout=3) as conn:
            conn.settimeout(3)
            conn.sendall(b"CONNECT 169.254.169.254:443 HTTP/1.1\r\nHost: 169.254.169.254:443\r\n\r\n")
            response = b""
            while b"\r\n" not in response and len(response) < 1024:
                chunk = conn.recv(256)
                if not chunk:
                    break
                response += chunk
        line = response.split(b"\r\n", 1)[0].split()
        return len(line) >= 2 and line[0] in (b"HTTP/1.0", b"HTTP/1.1") and line[1] == b"403"
    except OSError:
        return False


def main():
    ready = healthy()
    if "--check-only" in sys.argv:
        return 0 if ready else 1
    # Instance role only: no environment file and no provider secret on this host.
    import boto3
    from botocore.config import Config
    try:
        boto3.client("cloudwatch", region_name="eu-central-1", config=Config(
            connect_timeout=3, read_timeout=5, retries={"max_attempts": 0}
        )).put_metric_data(Namespace="Zwanga/MobishastraProxy", MetricData=[{
            "MetricName": "ProxyHealthy", "Value": 1 if ready else 0, "Unit": "Count",
            "Dimensions": [{"Name": "Component", "Value": "mobishastra-proxy"}],
        }])
    except Exception:
        # Never print SDK error bodies, environment or credentials.
        print("PROXY_HEALTH_REPORT_FAILED", file=sys.stderr)
        return 1
    return 0 if ready else 1


if __name__ == "__main__":
    sys.exit(main())
