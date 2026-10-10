#!/usr/bin/env bash
# Local production deploy for the portal (account.albena.ai).
# Gates: clean main == origin/main, worker typecheck + tests, full web build with the real
# Turnstile key, required pages present. Then D1 migrations, deploy, smoke test, and automatic
# rollback to the previous version if the smoke test fails.
#   portal/deploy.sh            deploy
#   portal/deploy.sh --dry-run  run every gate, deploy nothing
set -euo pipefail

DRY=0; [[ "${1:-}" == "--dry-run" ]] && DRY=1
ORIGIN="https://account.albena.ai"
ROOT="$(cd "$(dirname "$0")" && pwd)"
REQUIRED_PAGES=(index.html login.html invite.html household.html)

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nDEPLOY STOPPED: %s\n' "$*" >&2; exit 1; }

say "1/7 source"
cd "$ROOT/.."
git fetch -q origin main
[[ "$(git rev-parse --abbrev-ref HEAD)" == "main" ]] || die "not on main"
[[ -z "$(git status --porcelain --untracked-files=no -- portal)" ]] || die "uncommitted changes under portal/"
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || die "main is not origin/main (git pull)"
SHA="$(git rev-parse --short HEAD)"; echo "commit $SHA"

say "2/7 worker typecheck + tests"
cd "$ROOT/worker"
npm ci --silent
npx tsc --noEmit
npm test --silent

say "3/7 web build (real Turnstile key)"
KEY="${PUBLIC_TURNSTILE_SITE_KEY:-$(curl -fsS "$ORIGIN/login" | grep -o 'data-sitekey="[^"]*"' | head -1 | cut -d'"' -f2)}"
[[ "$KEY" == 0x4* && "$KEY" != 0x4AAAAAAAAAAAAA* ]] || die "no real Turnstile site key (set PUBLIC_TURNSTILE_SITE_KEY)"
cd "$ROOT/web"
npm ci --silent
rm -rf dist
PUBLIC_TURNSTILE_SITE_KEY="$KEY" npm run build >/tmp/albena-portal-build.log 2>&1 \
  || { tail -20 /tmp/albena-portal-build.log; die "web build failed"; }
grep -q "\[ERROR\]" /tmp/albena-portal-build.log && { grep "\[ERROR\]" /tmp/albena-portal-build.log; die "web build logged errors"; }
for p in "${REQUIRED_PAGES[@]}"; do [[ -s "dist/$p" ]] || die "missing dist/$p"; done
grep -q "$KEY" dist/login.html || die "login page lacks the Turnstile key"

say "4/7 wrangler dry-run"
cd "$ROOT/worker"
npx wrangler deploy --dry-run >/dev/null
PREV="$(npx wrangler deployments status 2>/dev/null | grep -o '[0-9a-f]\{8\}-[0-9a-f-]\{27\}' | head -1)"
echo "current live version $PREV"

if [[ $DRY == 1 ]]; then say "dry run OK — nothing deployed"; exit 0; fi

say "5/7 D1 migrations"
npx wrangler d1 migrations apply albena_portal --remote

say "6/7 deploy"
npx wrangler deploy --message "portal $SHA"

say "7/7 smoke test"
smoke() {
  local fail=0 p code
  for p in / /login /invite /household; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$ORIGIN$p"); [[ $code == 200 ]] || { echo "$p -> $code"; fail=1; }
  done
  for p in /api/me /api/account; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$ORIGIN$p"); [[ $code == 401 ]] || { echo "$p -> $code"; fail=1; }
  done
  curl -fsS "$ORIGIN/login" | grep -q "$KEY" || { echo "live login lacks Turnstile key"; fail=1; }
  return $fail
}
ok=0
for i in 1 2 3 4 5 6; do sleep 10; if smoke; then ok=1; break; fi; echo "retry $i (edge propagation)"; done
if [[ $ok != 1 ]]; then
  [[ -n "$PREV" ]] || die "smoke failed and no previous version known: roll back by hand"
  npx wrangler rollback "$PREV" -m "auto-rollback: smoke failed for $SHA" -y
  die "smoke failed; rolled back to $PREV (D1 migrations stay applied: keep them additive)"
fi
say "DEPLOYED $SHA to $ORIGIN"
