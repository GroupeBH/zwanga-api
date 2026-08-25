#!/usr/bin/env bash
set -euo pipefail

base_ref="${1:-}"
head_ref="${2:-HEAD}"

if [[ -z "${base_ref}" ]]; then
  base_ref="$(git rev-parse "${head_ref}^" 2>/dev/null || git rev-list --max-parents=0 "${head_ref}" | tail -n 1)"
elif [[ "${base_ref}" =~ ^0+$ ]]; then
  base_ref="$(git rev-list --max-parents=0 "${head_ref}" | tail -n 1)"
fi

if ! git cat-file -e "${base_ref}^{commit}" 2>/dev/null; then
  echo "Unable to inspect infrastructure documentation: base commit ${base_ref} is unavailable." >&2
  echo "Checkout the complete Git history (actions/checkout fetch-depth: 0)." >&2
  exit 2
fi

if [[ "${head_ref}" == "WORKTREE" ]]; then
  mapfile -t changed_files < <(
    {
      git diff --name-only "${base_ref}"
      git ls-files --others --exclude-standard
    } | sort -u
  )
else
  mapfile -t changed_files < <(git diff --name-only "${base_ref}" "${head_ref}")
fi
infra_changes=()
changelog_changed=false

for file in "${changed_files[@]}"; do
  if [[ "${file}" == "infra-aws/docs/CHANGELOG.md" ]]; then
    changelog_changed=true
  fi

  case "${file}" in
    infra-aws/docs/*)
      ;;
    infra-aws/*|.github/workflows/deploy.yml|.github/workflows/infra-documentation.yml|Dockerfile|docker-compose.yml|docker-compose.nginx.yml|.env.docker.example)
      infra_changes+=("${file}")
      ;;
  esac
done

if (( ${#infra_changes[@]} == 0 )); then
  echo "No infrastructure modification detected."
  exit 0
fi

if [[ "${changelog_changed}" != "true" ]]; then
  echo "Infrastructure files changed without updating infra-aws/docs/CHANGELOG.md:" >&2
  printf ' - %s\n' "${infra_changes[@]}" >&2
  echo "Copy infra-aws/docs/change-template.md and document the change in the changelog." >&2
  exit 1
fi

echo "Infrastructure documentation check passed for ${#infra_changes[@]} changed file(s)."
