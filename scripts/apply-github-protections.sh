#!/usr/bin/env bash
# Apply GitHub repo protections (NIST CM-3, CM-5, SA-11, SI-2). Idempotent: every call is a PUT/PATCH of desired state.
# Usage: scripts/apply-github-protections.sh [--dry-run] [--repo owner/name] [--branch main] [--reviewer user]
# Needs `gh` authenticated as a repo admin. Run by the repo owner, not by CI.
set -euo pipefail

DRY=0; REPO="kaoshotbeatz-ops/albena-site"; BRANCH="main"; REVIEWER="kaoshotbeatz-ops"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --repo) REPO="${2:?}"; shift 2 ;;
    --branch) BRANCH="${2:?}"; shift 2 ;;
    --reviewer) REVIEWER="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Job names from .github/workflows/ci.yml that must pass before merge.
CHECKS=("Controls data" "Build web" "Worker tests" "Secret scan (gitleaks)" "npm audit (high)" "Semgrep (p/default)" "Accessibility (Lighthouse >= 95)")

run() { # method path [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [ "$DRY" = 1 ]; then
    # shellcheck disable=SC2016
    echo "DRY-RUN: gh api -X $method $path${body:+ --input - <<< '$body'}"
  elif [ -n "$body" ]; then
    printf '%s' "$body" | gh api -X "$method" "$path" --input - >/dev/null && echo "ok: $method $path"
  else
    gh api -X "$method" "$path" >/dev/null && echo "ok: $method $path"
  fi
}

contexts="$(printf '%s\n' "${CHECKS[@]}" | jq -R . | jq -sc .)"

echo "== Branch protection: $REPO@$BRANCH"
protection="$(jq -nc --argjson c "$contexts" '{
  required_status_checks: {strict: true, contexts: $c},
  enforce_admins: false,
  required_pull_request_reviews: {
    required_approving_review_count: 1,
    require_code_owner_reviews: true,
    dismiss_stale_reviews: true
  },
  restrictions: null,
  required_linear_history: true,
  allow_force_pushes: false,
  allow_deletions: false,
  required_conversation_resolution: true
}')"
run PUT "repos/$REPO/branches/$BRANCH/protection" "$protection"

echo "== Secret scanning + push protection"
run PATCH "repos/$REPO" '{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}'

echo "== Dependabot alerts and security updates"
run PUT "repos/$REPO/vulnerability-alerts"
run PUT "repos/$REPO/automated-security-fixes"

echo "== Environment: production (required reviewer: $REVIEWER)"
if [ "$DRY" = 1 ]; then rid="<id of $REVIEWER>"; else rid="$(gh api "users/$REVIEWER" --jq .id)"; fi
env_body="$(jq -nc --arg id "$rid" '{
  reviewers: [{type: "User", id: ($id | tonumber? // $id)}],
  deployment_branch_policy: {protected_branches: true, custom_branch_policies: false}
}')"
run PUT "repos/$REPO/environments/production" "$env_body"
echo "Done."
