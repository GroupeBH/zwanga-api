#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="${ROOT_DIR}/terraform"
ANSIBLE_DIR="${ROOT_DIR}/ansible"

AWS_REGION="${AWS_REGION:-}"
KEY_NAME="${KEY_NAME:-}"
PRIVATE_KEY_PATH="${PRIVATE_KEY_PATH:-}"
ADMIN_CIDR="${ADMIN_CIDR:-}"
ALLOWED_SSH_CIDR_BLOCKS_JSON="${ALLOWED_SSH_CIDR_BLOCKS_JSON:-}"
DOMAIN="${DOMAIN:-}"
CADDY_EMAIL="${CADDY_EMAIL:-}"
INSTANCE_NAME="${INSTANCE_NAME:-}"
APP_IMAGE_REPOSITORY="${APP_IMAGE_REPOSITORY:-}"
APP_IMAGE_TAG="${APP_IMAGE_TAG:-}"
APP_ENV_FILE="${APP_ENV_FILE:-}"
APP_HEALTHCHECK_PATH="${APP_HEALTHCHECK_PATH:-/api/v1/health}"
APP_PORT="${APP_PORT:-5200}"
INSTANCE_TYPE="${INSTANCE_TYPE:-}"
TF_VARS_FILE="${TF_VARS_FILE:-${TF_DIR}/terraform.tfvars}"
TF_BACKEND_CONFIG_FILE="${TF_BACKEND_CONFIG_FILE:-${TF_DIR}/backend.hcl}"

TF_STATE_BUCKET="${TF_STATE_BUCKET:-}"
TF_STATE_KEY="${TF_STATE_KEY:-}"
TF_STATE_REGION="${TF_STATE_REGION:-}"
TF_BACKEND_USE_LOCKFILE="${TF_BACKEND_USE_LOCKFILE:-true}"
TF_LOCK_TABLE="${TF_LOCK_TABLE:-}"
SSH_RETRIES="${SSH_RETRIES:-30}"
SSH_RETRY_DELAY_SECONDS="${SSH_RETRY_DELAY_SECONDS:-10}"
SSH_CONNECT_TIMEOUT="${SSH_CONNECT_TIMEOUT:-5}"
SSH_KNOWN_HOSTS_FILE=""

cleanup() {
  if [[ -n "${SSH_KNOWN_HOSTS_FILE}" && -f "${SSH_KNOWN_HOSTS_FILE}" ]]; then
    rm -f "${SSH_KNOWN_HOSTS_FILE}"
  fi
}

trap cleanup EXIT

usage() {
  cat <<EOF
Usage:
  ./infra/deploy.sh \
    --private-key <path_to_private_key.pem> \
    [--aws-region <region>] \
    [--key-name <aws_key_pair_name>] \
    [--admin-cidr <your_public_ip/32>] \
    [--allowed-ssh-cidr-blocks-json <json_array>] \
    [--domain <api.example.com>] \
    [--email <ops@example.com>] \
    [--instance-name <zwanga-api>] \
    [--instance-type <t3.micro>] \
    [--app-image-repository <dockerhub-org/app>] \
    [--app-image-tag <tag>] \
    [--app-env-file <path_to_env_file>] \
    [--app-healthcheck-path </api/v1/health>] \
    [--app-port <5200>] \
    [--tfvars <path_to_terraform.tfvars>] \
    [--tf-backend-config <path_to_backend.hcl>] \
    [--tf-state-bucket <s3_bucket>] \
    [--tf-state-key <state_key>] \
    [--tf-state-region <region>] \
    [--tf-backend-use-lockfile <true|false>] \
    [--tf-lock-table <dynamodb_table>]

terraform/terraform.tfvars is loaded automatically when present.
terraform/backend.hcl is loaded automatically when present.
CLI arguments or environment variables override values from those files.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --aws-region)
      AWS_REGION="$2"
      shift 2
      ;;
    --key-name|--existing-key-name)
      KEY_NAME="$2"
      shift 2
      ;;
    --private-key)
      PRIVATE_KEY_PATH="$2"
      shift 2
      ;;
    --admin-cidr)
      ADMIN_CIDR="$2"
      shift 2
      ;;
    --allowed-ssh-cidr-blocks-json)
      ALLOWED_SSH_CIDR_BLOCKS_JSON="$2"
      shift 2
      ;;
    --domain)
      DOMAIN="$2"
      shift 2
      ;;
    --email)
      CADDY_EMAIL="$2"
      shift 2
      ;;
    --instance-name)
      INSTANCE_NAME="$2"
      shift 2
      ;;
    --instance-type)
      INSTANCE_TYPE="$2"
      shift 2
      ;;
    --app-image-repository)
      APP_IMAGE_REPOSITORY="$2"
      shift 2
      ;;
    --app-image-tag)
      APP_IMAGE_TAG="$2"
      shift 2
      ;;
    --app-env-file)
      APP_ENV_FILE="$2"
      shift 2
      ;;
    --app-healthcheck-path)
      APP_HEALTHCHECK_PATH="$2"
      shift 2
      ;;
    --app-port)
      APP_PORT="$2"
      shift 2
      ;;
    --tfvars)
      TF_VARS_FILE="$2"
      shift 2
      ;;
    --tf-backend-config)
      TF_BACKEND_CONFIG_FILE="$2"
      shift 2
      ;;
    --tf-state-bucket)
      TF_STATE_BUCKET="$2"
      shift 2
      ;;
    --tf-state-key)
      TF_STATE_KEY="$2"
      shift 2
      ;;
    --tf-state-region)
      TF_STATE_REGION="$2"
      shift 2
      ;;
    --tf-backend-use-lockfile)
      TF_BACKEND_USE_LOCKFILE="$2"
      shift 2
      ;;
    --tf-lock-table)
      TF_LOCK_TABLE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "${PRIVATE_KEY_PATH}" ]]; then
  echo "--private-key (or PRIVATE_KEY_PATH) is required." >&2
  usage
  exit 1
fi

HAS_BACKEND_FILE=0
if [[ -f "${TF_BACKEND_CONFIG_FILE}" ]]; then
  HAS_BACKEND_FILE=1
fi

if [[ "${HAS_BACKEND_FILE}" -eq 0 && -z "${TF_STATE_BUCKET}" ]]; then
  echo "Provide either terraform/backend.hcl or --tf-state-bucket for the Terraform S3 backend." >&2
  usage
  exit 1
fi

if [[ ! -f "${TF_VARS_FILE}" ]]; then
  missing_args=()
  if [[ -z "${KEY_NAME}" ]]; then
    missing_args+=("--key-name")
  fi
  if [[ -z "${ADMIN_CIDR}" ]]; then
    missing_args+=("--admin-cidr")
  fi
  if [[ -z "${APP_IMAGE_REPOSITORY}" ]]; then
    missing_args+=("--app-image-repository")
  fi

  if (( ${#missing_args[@]} > 0 )); then
    echo "Missing required inputs without tfvars: ${missing_args[*]}" >&2
    usage
    exit 1
  fi
fi

if [[ ! -f "${PRIVATE_KEY_PATH}" ]]; then
  echo "Private key not found: ${PRIVATE_KEY_PATH}" >&2
  exit 1
fi

if [[ -n "${APP_ENV_FILE}" && ! -f "${APP_ENV_FILE}" ]]; then
  echo "App env file not found: ${APP_ENV_FILE}" >&2
  exit 1
fi

if [[ "${APP_HEALTHCHECK_PATH}" != /* ]]; then
  echo "App healthcheck path must start with /: ${APP_HEALTHCHECK_PATH}" >&2
  exit 1
fi

if [[ "${TF_BACKEND_USE_LOCKFILE}" != "true" && "${TF_BACKEND_USE_LOCKFILE}" != "false" ]]; then
  echo "TF_BACKEND_USE_LOCKFILE must be true or false: ${TF_BACKEND_USE_LOCKFILE}" >&2
  exit 1
fi

for bin in terraform ansible-playbook ssh python3; do
  if ! command -v "${bin}" >/dev/null 2>&1; then
    echo "Missing required command: ${bin}" >&2
    exit 1
  fi
done

PRIVATE_KEY_PATH="$(realpath "${PRIVATE_KEY_PATH}")"
if [[ -n "${APP_ENV_FILE}" ]]; then
  APP_ENV_FILE="$(realpath "${APP_ENV_FILE}")"
fi

DEFAULT_TF_STATE_KEY="zwanga/${AWS_REGION:-eu-central-1}/terraform.tfstate"
DEFAULT_TF_STATE_REGION="${AWS_REGION:-eu-central-1}"
if [[ "${HAS_BACKEND_FILE}" -eq 0 ]]; then
  TF_STATE_KEY="${TF_STATE_KEY:-${DEFAULT_TF_STATE_KEY}}"
  TF_STATE_REGION="${TF_STATE_REGION:-${DEFAULT_TF_STATE_REGION}}"
fi

TF_APPLY_ARGS=(-auto-approve)
if [[ -f "${TF_VARS_FILE}" ]]; then
  TF_APPLY_ARGS+=(-var-file="${TF_VARS_FILE}")
fi

if [[ -n "${AWS_REGION}" ]]; then
  TF_APPLY_ARGS+=(-var "aws_region=${AWS_REGION}")
fi
if [[ -n "${KEY_NAME}" ]]; then
  TF_APPLY_ARGS+=(-var "key_name=${KEY_NAME}")
fi
if [[ -n "${ADMIN_CIDR}" ]]; then
  TF_APPLY_ARGS+=(-var "admin_cidr=${ADMIN_CIDR}")
fi
if [[ -n "${ALLOWED_SSH_CIDR_BLOCKS_JSON}" ]]; then
  TF_APPLY_ARGS+=(-var "allowed_ssh_cidr_blocks=${ALLOWED_SSH_CIDR_BLOCKS_JSON}")
fi
if [[ -n "${INSTANCE_TYPE}" ]]; then
  TF_APPLY_ARGS+=(-var "instance_type=${INSTANCE_TYPE}")
fi
if [[ -n "${INSTANCE_NAME}" ]]; then
  TF_APPLY_ARGS+=(-var "instance_name=${INSTANCE_NAME}")
fi
if [[ -n "${DOMAIN}" ]]; then
  TF_APPLY_ARGS+=(-var "domain_name=${DOMAIN}")
fi
if [[ -n "${CADDY_EMAIL}" ]]; then
  TF_APPLY_ARGS+=(-var "caddy_email=${CADDY_EMAIL}")
fi
if [[ -n "${APP_IMAGE_REPOSITORY}" ]]; then
  TF_APPLY_ARGS+=(-var "app_image_repository=${APP_IMAGE_REPOSITORY}")
fi
if [[ -n "${APP_IMAGE_TAG}" ]]; then
  TF_APPLY_ARGS+=(-var "app_image_tag=${APP_IMAGE_TAG}")
fi
if [[ -n "${APP_HEALTHCHECK_PATH}" ]]; then
  TF_APPLY_ARGS+=(-var "app_healthcheck_path=${APP_HEALTHCHECK_PATH}")
fi
if [[ -n "${APP_PORT}" ]]; then
  TF_APPLY_ARGS+=(-var "app_port=${APP_PORT}")
fi

echo "==> Terraform init"
INIT_ARGS=(-reconfigure)
if [[ "${HAS_BACKEND_FILE}" -eq 1 ]]; then
  INIT_ARGS+=("-backend-config=${TF_BACKEND_CONFIG_FILE}")
fi
if [[ -n "${TF_STATE_BUCKET}" ]]; then
  INIT_ARGS+=("-backend-config=bucket=${TF_STATE_BUCKET}")
fi
if [[ -n "${TF_STATE_KEY}" ]]; then
  INIT_ARGS+=("-backend-config=key=${TF_STATE_KEY}")
fi
if [[ -n "${TF_STATE_REGION}" ]]; then
  INIT_ARGS+=("-backend-config=region=${TF_STATE_REGION}")
fi
INIT_ARGS+=("-backend-config=encrypt=true")
INIT_ARGS+=("-backend-config=use_lockfile=${TF_BACKEND_USE_LOCKFILE}")
if [[ -n "${TF_LOCK_TABLE}" ]]; then
  INIT_ARGS+=("-backend-config=dynamodb_table=${TF_LOCK_TABLE}")
fi

terraform -chdir="${TF_DIR}" init "${INIT_ARGS[@]}"

echo "==> Terraform apply"
terraform -chdir="${TF_DIR}" apply "${TF_APPLY_ARGS[@]}"

terraform_output_raw() {
  local key="$1"
  terraform -chdir="${TF_DIR}" output -raw "${key}"
}

terraform_output_json() {
  local key="$1"
  terraform -chdir="${TF_DIR}" output -json "${key}"
}

echo "==> Loading Terraform outputs"
PRIMARY_PUBLIC_IP="$(terraform_output_raw deploy_primary_public_ip)"
PRIMARY_PRIVATE_IP="$(terraform_output_raw deploy_primary_private_ip)"
SECONDARY_ENABLED="$(terraform_output_raw deploy_secondary_enabled)"
SECONDARY_PUBLIC_IP=""
SECONDARY_PRIVATE_IP=""
if [[ "${SECONDARY_ENABLED}" == "true" ]]; then
  SECONDARY_PUBLIC_IP="$(terraform_output_raw deploy_secondary_public_ip)"
  SECONDARY_PRIVATE_IP="$(terraform_output_raw deploy_secondary_private_ip)"
fi
APP_URL="$(terraform_output_raw app_url)"
HEALTH_URL="$(terraform_output_raw health_url)"
ADMIN_CIDRS_JSON="$(terraform_output_json deploy_admin_cidrs)"
APP_IMAGE_REPOSITORY="$(terraform_output_raw deploy_app_image_repository)"
APP_IMAGE_TAG="$(terraform_output_raw deploy_app_image_tag)"
APP_PORT="$(terraform_output_raw deploy_app_port)"
INSTANCE_NAME="$(terraform_output_raw deploy_instance_name)"
AWS_REGION="$(terraform_output_raw deploy_region)"
DOMAIN="$(terraform_output_raw deploy_domain_name)"
CADDY_EMAIL="$(terraform_output_raw deploy_caddy_email)"

if [[ -z "${APP_IMAGE_REPOSITORY}" || -z "${PRIMARY_PUBLIC_IP}" || -z "${PRIMARY_PRIVATE_IP}" ]]; then
  echo "deploy_primary_public_ip, deploy_primary_private_ip, and app_image_repository are required." >&2
  exit 1
fi

if [[ "${SECONDARY_ENABLED}" == "true" && ( -z "${SECONDARY_PUBLIC_IP}" || -z "${SECONDARY_PRIVATE_IP}" ) ]]; then
  echo "secondary_instance_enabled is true, but Terraform did not return both public and private IPs for the secondary node." >&2
  exit 1
fi

if ! python3 - "${ADMIN_CIDRS_JSON}" <<'PY'
import json
import sys

cidrs = json.loads(sys.argv[1])
if not isinstance(cidrs, list) or not cidrs:
    raise SystemExit(1)
PY
then
  echo "At least one admin CIDR is required for SSH firewall rules." >&2
  exit 1
fi

SSH_KNOWN_HOSTS_FILE="$(mktemp)"
chmod 600 "${SSH_KNOWN_HOSTS_FILE}"
ANSIBLE_SSH_COMMON_ARGS="-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${SSH_KNOWN_HOSTS_FILE}"

echo "==> Rendering Ansible inventory"
{
  echo "[app]"
  echo "primary ansible_host=${PRIMARY_PUBLIC_IP} private_ip=${PRIMARY_PRIVATE_IP} ansible_user=ubuntu ansible_ssh_private_key_file=${PRIVATE_KEY_PATH} ansible_ssh_common_args=\"${ANSIBLE_SSH_COMMON_ARGS}\""
  if [[ "${SECONDARY_ENABLED}" == "true" && -n "${SECONDARY_PUBLIC_IP}" ]]; then
    echo "secondary ansible_host=${SECONDARY_PUBLIC_IP} private_ip=${SECONDARY_PRIVATE_IP} ansible_user=ubuntu ansible_ssh_private_key_file=${PRIVATE_KEY_PATH} ansible_ssh_common_args=\"${ANSIBLE_SSH_COMMON_ARGS}\""
  fi
  echo
  echo "[app:vars]"
  echo "ansible_python_interpreter=/usr/bin/python3"
} > "${ANSIBLE_DIR}/inventory.ini"

wait_for_host_ssh() {
  local host_role="$1"
  local host_ip="$2"
  local last_ssh_error=""
  local -a ssh_options=(
    -o BatchMode=yes
    -o StrictHostKeyChecking=accept-new
    -o UserKnownHostsFile="${SSH_KNOWN_HOSTS_FILE}"
    -o ConnectTimeout="${SSH_CONNECT_TIMEOUT}"
    -i "${PRIVATE_KEY_PATH}"
  )

  echo "==> Waiting for SSH on ${host_role} (${host_ip})"
  for ((i=1; i<=SSH_RETRIES; i++)); do
    if last_ssh_error="$(ssh "${ssh_options[@]}" "ubuntu@${host_ip}" "echo ok" 2>&1 >/dev/null)"; then
      last_ssh_error=""
      return 0
    fi

    if (( i == SSH_RETRIES )); then
      echo "SSH not reachable on ${host_role} after ${SSH_RETRIES} attempts." >&2
      if [[ -n "${last_ssh_error}" ]]; then
        echo "Last SSH error: ${last_ssh_error}" >&2
      fi
      echo "Target IP: ${host_ip}" >&2
      echo "Private key path: ${PRIVATE_KEY_PATH}" >&2
      return 1
    fi

    echo "SSH not ready yet on ${host_role} (attempt ${i}/${SSH_RETRIES}); retrying in ${SSH_RETRY_DELAY_SECONDS}s..." >&2
    sleep "${SSH_RETRY_DELAY_SECONDS}"
  done
}

wait_for_host_ssh primary "${PRIMARY_PUBLIC_IP}"
if [[ "${SECONDARY_ENABLED}" == "true" && -n "${SECONDARY_PUBLIC_IP}" ]]; then
  wait_for_host_ssh secondary "${SECONDARY_PUBLIC_IP}"
fi

echo "==> Running Ansible playbook"
ANSIBLE_ARGS=(
  -i "${ANSIBLE_DIR}/inventory.ini"
  "${ANSIBLE_DIR}/playbooks/deploy.yml"
  --extra-vars "admin_cidrs=${ADMIN_CIDRS_JSON}"
  --extra-vars "app_image_repository=${APP_IMAGE_REPOSITORY}"
  --extra-vars "app_image_tag=${APP_IMAGE_TAG}"
  --extra-vars "app_port=${APP_PORT}"
  --extra-vars "app_healthcheck_path=${APP_HEALTHCHECK_PATH}"
  --extra-vars "api_health_path=${APP_HEALTHCHECK_PATH}"
  --extra-vars "cloudwatch_region=${AWS_REGION}"
  --extra-vars "cloudwatch_instance_name=${INSTANCE_NAME}"
)
if [[ -n "${DOMAIN}" ]]; then
  ANSIBLE_ARGS+=(--extra-vars "domain=${DOMAIN}")
fi
if [[ -n "${CADDY_EMAIL}" ]]; then
  ANSIBLE_ARGS+=(--extra-vars "caddy_email=${CADDY_EMAIL}")
fi
if [[ -n "${APP_ENV_FILE}" ]]; then
  ANSIBLE_ARGS+=(--extra-vars "app_env_file=${APP_ENV_FILE}")
fi

ANSIBLE_HOST_KEY_CHECKING=True ansible-playbook "${ANSIBLE_ARGS[@]}"

echo "==> Deployment complete"
echo "App URL: ${APP_URL}"
echo "Primary public IP: ${PRIMARY_PUBLIC_IP}"
if [[ "${SECONDARY_ENABLED}" == "true" && -n "${SECONDARY_PUBLIC_IP}" ]]; then
  echo "Secondary public IP: ${SECONDARY_PUBLIC_IP}"
fi
echo "Documented health URL: ${HEALTH_URL}"
