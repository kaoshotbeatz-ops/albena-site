#!/usr/bin/env bash
# Post-deploy smoke test for the portal. Usage: smoke-portal.sh https://host
# Pages /, /login, /invite must return 200; /api/me must return 401 (auth enforced, worker is up).
set -u
base="${1:?usage: smoke-portal.sh BASE_URL}"; base="${base%/}"
attempts="${SMOKE_ATTEMPTS:-6}"; delay="${SMOKE_DELAY:-10}"
fail=0
check() { # path expected_status
  local path="$1" want="$2" got="" i
  for i in $(seq 1 "$attempts"); do
    got=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$base$path" || true)
    [ "$got" = "$want" ] && { echo "ok   $path -> $got"; return 0; }
    sleep "$delay"   # new version / assets can take a few seconds to propagate
  done
  echo "::error title=Smoke test::$base$path returned $got, expected $want"; fail=1
}
check / 200
check /login 200
check /invite 200
check /api/me 401
[ "$fail" = 0 ] && echo "smoke OK: $base" || { echo "smoke FAILED: $base"; exit 1; }
