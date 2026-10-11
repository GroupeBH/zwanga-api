"""Staging-only lifecycle controller. No secrets or application payloads logged."""
import os
from datetime import datetime, timezone

import boto3

MAX_SESSION_SECONDS = 7200


def handler(event, context):
    action = event.get("action", "status")
    if action not in {"start", "stop", "status", "watchdog"}:
        raise ValueError("Unsupported staging action")
    instance_id = os.environ["INSTANCE_ID"]
    ec2 = boto3.client("ec2")
    route53 = boto3.client("route53")
    instance = ec2.describe_instances(InstanceIds=[instance_id])["Reservations"][0]["Instances"][0]
    tags = {t["Key"]: t["Value"] for t in instance.get("Tags", [])}
    if tags.get("Environment") != "staging" or tags.get("Name") != "zwanga-api-staging":
        raise ValueError("Instance isolation check failed")
    state = instance["State"]["Name"]
    age = (datetime.now(timezone.utc) - instance["LaunchTime"]).total_seconds()
    expired = state in {"running", "pending"} and age >= MAX_SESSION_SECONDS

    def dns(address):
        route53.change_resource_record_sets(
            HostedZoneId=os.environ["HOSTED_ZONE"],
            ChangeBatch={"Changes": [{"Action": "UPSERT", "ResourceRecordSet": {
                "Name": os.environ["DOMAIN"], "Type": "A", "TTL": 60,
                "ResourceRecords": [{"Value": address}],
            }}]},
        )

    if action == "stop" or expired:
        # Stop is attempted even when DNS is unavailable: cost safety first.
        try:
            dns("0.0.0.0")
        finally:
            if state in {"pending", "running"}:
                ec2.stop_instances(InstanceIds=[instance_id])
        return {"state": "stopping" if state in {"pending", "running"} else state,
                "expired": expired}
    if action == "start" and state == "stopped":
        dns("0.0.0.0")
        ec2.start_instances(InstanceIds=[instance_id])
        return {"state": "pending", "maxSessionSeconds": MAX_SESSION_SECONDS}
    address = instance.get("PublicIpAddress") if state == "running" else None
    dns(address or "0.0.0.0")
    return {"state": state, "address": address,
            "remainingSeconds": max(0, int(MAX_SESSION_SECONDS - age)) if address else 0}
