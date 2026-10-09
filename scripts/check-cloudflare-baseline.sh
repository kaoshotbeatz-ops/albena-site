#!/usr/bin/env bash
# Cloudflare zone baseline check (NIST CM-2/CM-6). Usage: scripts/check-cloudflare-baseline.sh [zone] [--out file.json]
# Needs the `cf` CLI (authenticated locally, or CLOUDFLARE_API_TOKEN in CI). Skips (exit 0) in CI without a token.
# Output: JSON {zone, checked_at, status, checks[]}. Exit 1 if any required check fails; DNSSEC is report-only.
set -uo pipefail

ZONE="albena.ai"; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?--out needs a file}"; shift 2 ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) ZONE="$1"; shift ;;
  esac
done

emit() { if [ -n "$OUT" ]; then printf '%s\n' "$1" | tee "$OUT"; else printf '%s\n' "$1"; fi; }
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ -n "${CI:-}" ] && [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  emit "$(jq -n --arg z "$ZONE" --arg t "$now" '{zone:$z,checked_at:$t,status:"skipped",reason:"no CLOUDFLARE_API_TOKEN in CI",checks:[]}')"
  exit 0
fi
command -v cf >/dev/null || { echo "cf CLI not found" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq not found" >&2; exit 2; }

checks='[]'
add() { # name required(true|false) status(pass|fail|report|error) expected actual
  checks="$(jq -c --arg n "$1" --argjson r "$2" --arg s "$3" --arg e "$4" --arg a "$5" \
    '. + [{name:$n,required:$r,status:$s,expected:$e,actual:$a}]' <<<"$checks")"
}
cfjson() { cf "$@" -z "$ZONE" 2>/dev/null | sed -n '/^[[{]/,$p'; }
setting() { cfjson zones settings get "$1" | jq -r "$2" 2>/dev/null; }

v="$(setting always_use_https '.value')"
if [ "$v" = "on" ]; then add always_use_https true pass on "$v"; else add always_use_https true fail on "${v:-unreadable}"; fi

v="$(setting min_tls_version '.value')"
case "$v" in 1.2|1.3) add min_tls_version true pass ">=1.2" "$v" ;; *) add min_tls_version true fail ">=1.2" "${v:-unreadable}" ;; esac

v="$(setting ssl '.value')"
case "$v" in strict|full_strict) add ssl_mode true pass strict "$v" ;; *) add ssl_mode true fail strict "${v:-unreadable}" ;; esac

# HSTS: edge setting, or (Worker-set) header on the live site. Either satisfies; both are reported.
edge="$(setting security_header '.value.strict_transport_security | "\(.enabled) max_age=\(.max_age)"')"
live="$(curl -sSI --max-time 20 "https://$ZONE/" 2>/dev/null | tr -d '\r' | grep -i '^strict-transport-security:' | head -1 | cut -d: -f2- | sed 's/^ *//')"
age="$(printf '%s' "$live" | grep -io 'max-age=[0-9]*' | cut -d= -f2)"
if [ "${age:-0}" -ge 31536000 ] || printf '%s' "$edge" | grep -q '^true max_age=[0-9]\{8,\}'; then
  add hsts true pass "max-age>=31536000 (edge setting or response header)" "edge: ${edge:-n/a}; header: ${live:-none}"
else
  add hsts true fail "max-age>=31536000 (edge setting or response header)" "edge: ${edge:-n/a}; header: ${live:-none}"
fi

d="$(cfjson dns dnssec get | jq -r '.status' 2>/dev/null)"
add dnssec false report active "${d:-unreadable}"

failed="$(jq '[.[] | select(.required and .status=="fail")] | length' <<<"$checks")"
status=pass; [ "$failed" -gt 0 ] && status=fail
emit "$(jq -n --arg z "$ZONE" --arg t "$now" --arg s "$status" --argjson c "$checks" '{zone:$z,checked_at:$t,status:$s,checks:$c}')"
[ "$status" = pass ]
