#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
infra_dir="$(cd "${script_dir}/.." && pwd)"

cd "${infra_dir}"

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required." >&2
  exit 1
fi

if ! command -v terraform >/dev/null 2>&1; then
  echo "terraform is required." >&2
  exit 1
fi

aws_region="${AWS_REGION:-$(terraform output -raw aws_region)}"
cluster_name="${ECS_CLUSTER:-$(terraform output -raw ecs_cluster_name)}"
service_name="${ECS_SERVICE:-$(terraform output -raw ecs_service_name)}"
task_definition="${DATABASE_IMPORT_TASK_DEFINITION:-$(terraform output -raw database_import_task_definition_arn)}"
database_import_security_group="${DATABASE_IMPORT_SECURITY_GROUP_ID:-$(terraform output -raw database_import_security_group_id)}"
container_name="neon-to-rds-import"

parameter_name="$(terraform output -raw database_import_source_url_parameter_name)"
if ! aws ssm get-parameter --region "${aws_region}" --name "${parameter_name}" --query "Parameter.Name" --output text >/dev/null; then
  echo "Missing SSM parameter ${parameter_name}." >&2
  echo "Run scripts/put-neon-database-url-to-ssm.sh first." >&2
  exit 1
fi

subnets="$(aws ecs describe-services \
  --region "${aws_region}" \
  --cluster "${cluster_name}" \
  --services "${service_name}" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration.subnets' \
  --output text | tr '\t' ',')"

# This economic setup has no NAT Gateway. The one-off import task runs in
# public subnets and therefore needs a public IP to reach Neon over TCP/5432.
assign_public_ip="${DATABASE_IMPORT_ASSIGN_PUBLIC_IP:-ENABLED}"

if [[ -z "${subnets}" || "${subnets}" == "None" || -z "${database_import_security_group}" || "${database_import_security_group}" == "None" ]]; then
  echo "Unable to resolve ECS service network configuration." >&2
  exit 1
fi

cat <<EOF
This will start a one-off ECS task that imports Neon into AWS RDS.

Important:
- Stop writes to the Render/Neon production app before running this.
- The target RDS schema can be dropped/recreated by pg_restore --clean --if-exists.
- Keep the existing Neon database untouched until verification is complete.

Cluster:         ${cluster_name}
Service network: ${service_name}
Task definition: ${task_definition}
Import SG:       ${database_import_security_group}
EOF

read -r -p "Type IMPORT to continue: " confirmation
if [[ "${confirmation}" != "IMPORT" ]]; then
  echo "Aborted."
  exit 0
fi

task_arn="$(aws ecs run-task \
  --region "${aws_region}" \
  --cluster "${cluster_name}" \
  --launch-type FARGATE \
  --task-definition "${task_definition}" \
  --network-configuration "awsvpcConfiguration={subnets=[${subnets}],securityGroups=[${database_import_security_group}],assignPublicIp=${assign_public_ip}}" \
  --started-by "neon-to-rds-import" \
  --query 'tasks[0].taskArn' \
  --output text)"

if [[ -z "${task_arn}" || "${task_arn}" == "None" ]]; then
  echo "Failed to start ECS import task." >&2
  exit 1
fi

echo "Started ECS task: ${task_arn}"
echo "Waiting for task to stop..."

aws ecs wait tasks-stopped \
  --region "${aws_region}" \
  --cluster "${cluster_name}" \
  --tasks "${task_arn}"

exit_code="$(aws ecs describe-tasks \
  --region "${aws_region}" \
  --cluster "${cluster_name}" \
  --tasks "${task_arn}" \
  --query "tasks[0].containers[?name=='${container_name}'].exitCode | [0]" \
  --output text)"

reason="$(aws ecs describe-tasks \
  --region "${aws_region}" \
  --cluster "${cluster_name}" \
  --tasks "${task_arn}" \
  --query "tasks[0].stoppedReason" \
  --output text)"

if [[ "${exit_code}" != "0" ]]; then
  echo "Import failed. ECS exit code: ${exit_code}. Reason: ${reason}" >&2
  echo "Open CloudWatch Logs group /ecs/zwanga-api-production/database-import for details." >&2
  exit 1
fi

echo "Import completed successfully. ECS task exit code: 0."
