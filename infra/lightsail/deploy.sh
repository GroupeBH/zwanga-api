#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="${ROOT_DIR}/terraform"
ANSIBLE_DIR="${ROOT_DIR}/ansible"

AWS_REGION="${AWS_REGION:-}"
KEY_PAIR_NAME="${KEY_PAIR_NAME:-}"
PRIVATE_KEY_PATH="${PRIVATE_KEY_PATH:-}"
SSH_PUBLIC_KEY="${SSH_PUBLIC_KEY:-}"
SSH_PUBLIC_KEY_FILE="${SSH_PUBLIC_KEY_FILE:-}"
ADMIN_CIDR="${ADMIN_CIDR:-}"
ALLOWED_SSH_CIDR_BLOCKS_JSON="${ALLOWED_SSH_CIDR_BLOCKS_JSON:-}"
DOMAIN="${DOMAIN:-}"
CADDY_EMAIL="${CADDY_EMAIL:-}"
INSTANCE_NAME="${INSTANCE_NAME:-}"
LIGHTSAIL_BUNDLE_ID="${LIGHTSAIL_BUNDLE_ID:-}"
APP_IMAGE_REPOSITORY="${APP_IMAGE_REPOSITORY:-}"
APP_IMAGE_TAG="${APP_IMAGE_TAG:-}"
APP_ENV_FILE="${APP_ENV_FILE:-}"
APP_HEALTHCHECK_PATH="${APP_HEALTHCHECK_PATH:-/api/v1/health}"
APP_PORT="${APP_PORT:-5200}"
RUN_DB_MIGRATIONS="${RUN_DB_MIGRATIONS:-false}"
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
  ./infra/lightsail/deploy.sh \
    --private-key <path_to_private_key.pem> \
    [--ssh-public-key <ssh_public_key>] \
    [--ssh-public-key-file <path_to_public_key.pub>] \
    [--aws-region <region>] \
    [--key-pair-name <lightsail_key_pair_name>] \
    [--admin-cidr <your_public_ip/32>] \
    [--allowed-ssh-cidr-blocks-json <json_array>] \
    [--domain <api.example.com>] \
    [--email <ops@example.com>] \
    [--instance-name <zwanga-api>] \
    [--bundle-id <small_3_0>] \
    [--app-image-repository <dockerhub-org/app>] \
    [--app-image-tag <tag>] \
    [--app-env-file <path_to_env_file>] \
    [--app-healthcheck-path </api/v1/health>] \
    [--app-port <5200>] \
    [--run-db-migrations <true|false>] \
    [--tfvars <path_to_terraform.tfvars>] \
    [--tf-backend-config <path_to_backend.hcl>] \
    [--tf-state-bucket <s3_bucket>] \
    [--tf-state-key <state_key>] \
    [--tf-state-region <region>] \
    [--tf-backend-use-lockfile <true|false>] \
    [--tf-lock-table <dynamodb_table>]

When --key-pair-name and --ssh-public-key are omitted, Lightsail uses the
regional default key pair. The private key passed with --private-key must match
the key pair used by the instance.

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
    --key-pair-name|--key-name|--existing-key-name)
      KEY_PAIR_NAME="$2"
      shift 2
      ;;
    --private-key)
      PRIVATE_KEY_PATH="$2"
      shift 2
      ;;
    --ssh-public-key)
      SSH_PUBLIC_KEY="$2"
      shift 2
      ;;
    --ssh-public-key-file)
      SSH_PUBLIC_KEY_FILE="$2"
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
    --bundle-id|--lightsail-bundle-id)
      LIGHTSAIL_BUNDLE_ID="$2"
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
    --run-db-migrations)
      RUN_DB_MIGRATIONS="$2"
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
  if [[ -z "${ADMIN_CIDR}" && -z "${ALLOWED_SSH_CIDR_BLOCKS_JSON}" ]]; then
    missing_args+=("--admin-cidr or --allowed-ssh-cidr-blocks-json")
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

if [[ -n "${SSH_PUBLIC_KEY_FILE}" && ! -f "${SSH_PUBLIC_KEY_FILE}" ]]; then
  echo "SSH public key file not found: ${SSH_PUBLIC_KEY_FILE}" >&2
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

if [[ "${RUN_DB_MIGRATIONS}" != "true" && "${RUN_DB_MIGRATIONS}" != "false" ]]; then
  echo "RUN_DB_MIGRATIONS must be true or false: ${RUN_DB_MIGRATIONS}" >&2
  exit 1
fi

for bin in terraform ansible-playbook ssh python3; do
  if ! command -v "${bin}" >/dev/null 2>&1; then
    echo "Missing required command: ${bin}" >&2
    exit 1
  fi
done

PRIVATE_KEY_PATH="$(realpath "${PRIVATE_KEY_PATH}")"
if [[ -n "${SSH_PUBLIC_KEY_FILE}" ]]; then
  SSH_PUBLIC_KEY_FILE="$(realpath "${SSH_PUBLIC_KEY_FILE}")"
  SSH_PUBLIC_KEY="$(tr -d '\r\n' < "${SSH_PUBLIC_KEY_FILE}")"
fi
if [[ -n "${APP_ENV_FILE}" ]]; then
  APP_ENV_FILE="$(realpath "${APP_ENV_FILE}")"
fi

DEFAULT_TF_STATE_KEY="zwanga/lightsail/${AWS_REGION:-eu-central-1}/terraform.tfstate"
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
if [[ -n "${SSH_PUBLIC_KEY}" ]]; then
  TF_APPLY_ARGS+=(-var "ssh_public_key=${SSH_PUBLIC_KEY}")
  TF_APPLY_ARGS+=(-var "key_pair_name=")
elif [[ -n "${KEY_PAIR_NAME}" ]]; then
  TF_APPLY_ARGS+=(-var "key_pair_name=${KEY_PAIR_NAME}")
fi
if [[ -n "${ADMIN_CIDR}" ]]; then
  TF_APPLY_ARGS+=(-var "admin_cidr=${ADMIN_CIDR}")
fi
if [[ -n "${ALLOWED_SSH_CIDR_BLOCKS_JSON}" ]]; then
  TF_APPLY_ARGS+=(-var "allowed_ssh_cidr_blocks=${ALLOWED_SSH_CIDR_BLOCKS_JSON}")
fi
if [[ -n "${LIGHTSAIL_BUNDLE_ID}" ]]; then
  TF_APPLY_ARGS+=(-var "bundle_id=${LIGHTSAIL_BUNDLE_ID}")
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
PUBLIC_IP="$(terraform_output_raw deploy_public_ip)"
PRIVATE_IP="$(terraform_output_raw deploy_private_ip)"
SSH_USERNAME="$(terraform_output_raw deploy_ssh_username)"
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

if [[ -z "${APP_IMAGE_REPOSITORY}" || -z "${PUBLIC_IP}" || -z "${PRIVATE_IP}" || -z "${SSH_USERNAME}" ]]; then
  echo "deploy_public_ip, deploy_private_ip, deploy_ssh_username, and app_image_repository are required." >&2
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
  echo "primary ansible_host=${PUBLIC_IP} private_ip=${PRIVATE_IP} ansible_user=${SSH_USERNAME} ansible_ssh_private_key_file=${PRIVATE_KEY_PATH} ansible_ssh_common_args=\"${ANSIBLE_SSH_COMMON_ARGS}\""
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
    if last_ssh_error="$(ssh "${ssh_options[@]}" "${SSH_USERNAME}@${host_ip}" "echo ok" 2>&1 >/dev/null)"; then
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

wait_for_host_ssh primary "${PUBLIC_IP}"

echo "==> Running Ansible playbook"
ANSIBLE_ARGS=(
  -i "${ANSIBLE_DIR}/inventory.ini"
  "${ANSIBLE_DIR}/playbooks/deploy.yml"
  --extra-vars "{\"admin_cidrs\":${ADMIN_CIDRS_JSON}}"
  --extra-vars "app_image_repository=${APP_IMAGE_REPOSITORY}"
  --extra-vars "app_image_tag=${APP_IMAGE_TAG}"
  --extra-vars "app_port=${APP_PORT}"
  --extra-vars "app_healthcheck_path=${APP_HEALTHCHECK_PATH}"
  --extra-vars "api_health_path=${APP_HEALTHCHECK_PATH}"
  --extra-vars "run_db_migrations=${RUN_DB_MIGRATIONS}"
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
echo "Public IP: ${PUBLIC_IP}"
echo "Documented health URL: ${HEALTH_URL}"
