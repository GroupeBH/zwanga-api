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
parameter_name="$(terraform output -raw database_import_source_url_parameter_name)"
kms_key_alias="$(terraform output -raw application_kms_key_alias)"

neon_database_url="${NEON_DATABASE_URL:-}"
if [[ -z "${neon_database_url}" ]]; then
  read -r -s -p "Paste Neon DATABASE_URL: " neon_database_url
  echo
fi

if [[ -z "${neon_database_url}" ]]; then
  echo "NEON_DATABASE_URL cannot be empty." >&2
  exit 1
fi

if [[ "${neon_database_url}" != postgres://* && "${neon_database_url}" != postgresql://* ]]; then
  echo "The value does not look like a PostgreSQL connection URL." >&2
  exit 1
fi

aws ssm put-parameter \
  --region "${aws_region}" \
  --name "${parameter_name}" \
  --type SecureString \
  --key-id "${kms_key_alias}" \
  --value "${neon_database_url}" \
  --overwrite >/dev/null

echo "Stored Neon DATABASE_URL in SSM parameter ${parameter_name}."
echo "The value was not written to Git or printed to the terminal."
