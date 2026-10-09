#!/usr/bin/env bash
# Assert security response headers. Usage: scripts/check-headers.sh <url> | --file <headers.txt>
# Exit 1 on any failed required check; warnings do not fail.
set -uo pipefail

if [ "${1:-}" = "--file" ]; then
  HEADERS="$(cat "${2:?headers file}")"; URL="(file)"
else
  URL="${1:?usage: check-headers.sh <url> | --file <headers.txt>}"
  HEADERS="$(curl -sS -D - -o /dev/null --max-time 20 --retry 2 "$URL")" || { echo "FAIL: request to $URL failed"; exit 1; }
fi
HEADERS="$(printf '%s' "$HEADERS" | tr -d '\r')"
# Use the last response block (after redirects)
HEADERS="$(printf '%s\n' "$HEADERS" | awk 'BEGIN{RS="";ORS="\n\n"} {last=$0} END{print last}')"

fail=0
hdr() { printf '%s\n' "$HEADERS" | grep -i "^$1:" | head -1 | cut -d: -f2- | sed 's/^ *//'; }
pass() { echo "PASS: $1"; }
bad()  { echo "FAIL: $1"; fail=1; }
warn() { echo "WARN: $1"; }

hsts="$(hdr strict-transport-security)"
if [ -z "$hsts" ]; then bad "Strict-Transport-Security missing"
else
  age="$(printf '%s' "$hsts" | grep -io 'max-age=[0-9]*' | cut -d= -f2)"
  if [ "${age:-0}" -ge 31536000 ]; then pass "HSTS max-age=$age"; else bad "HSTS max-age too low (${age:-none}); need >= 31536000"; fi
fi

csp="$(hdr content-security-policy)"
if [ -z "$csp" ]; then bad "Content-Security-Policy missing"
else
  pass "CSP present"
  printf '%s' "$csp" | grep -qi "unsafe-eval" && bad "CSP allows unsafe-eval"
  printf '%s' "$csp" | grep -qi "default-src\|script-src" || bad "CSP lacks default-src/script-src"
fi

xfo="$(hdr x-frame-options)"
if printf '%s' "$xfo" | grep -qiE '^(DENY|SAMEORIGIN)$'; then pass "X-Frame-Options $xfo"
elif printf '%s' "$csp" | grep -qi "frame-ancestors"; then pass "frame-ancestors in CSP (X-Frame-Options absent)"; warn "add X-Frame-Options for legacy browsers"
else bad "No X-Frame-Options or CSP frame-ancestors"; fi

xcto="$(hdr x-content-type-options)"
if printf '%s' "$xcto" | grep -qi '^nosniff$'; then pass "X-Content-Type-Options nosniff"; else bad "X-Content-Type-Options: nosniff missing"; fi

[ -n "$(hdr referrer-policy)" ] && pass "Referrer-Policy $(hdr referrer-policy)" || bad "Referrer-Policy missing"
[ -n "$(hdr permissions-policy)" ] && pass "Permissions-Policy present" || bad "Permissions-Policy missing"

[ -n "$(hdr x-powered-by)" ] && warn "X-Powered-By discloses: $(hdr x-powered-by)"
server="$(hdr server)"
printf '%s' "$server" | grep -qE '[0-9]+\.[0-9]+' && warn "Server header may disclose version: $server"
acao="$(hdr access-control-allow-origin)"
[ "$acao" = "*" ] && warn "Access-Control-Allow-Origin is * (acceptable only for public static content)"
if printf '%s\n' "$HEADERS" | grep -i '^set-cookie:' | grep -viq 'secure'; then warn "Set-Cookie without Secure flag"; fi

# HTTP -> HTTPS redirect (URL mode, https only)
case "$URL" in
  https://*)
    http_url="http://${URL#https://}"
    code="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 15 "$http_url" 2>/dev/null || true)"
    case "$code" in 301*https://*|308*https://*|302*https://*) pass "HTTP redirects to HTTPS ($code)";; *) warn "HTTP did not redirect to HTTPS ($code)";; esac;;
esac

if [ "$fail" -ne 0 ]; then echo "RESULT: FAILED for $URL"; exit 1; fi
echo "RESULT: OK for $URL"
