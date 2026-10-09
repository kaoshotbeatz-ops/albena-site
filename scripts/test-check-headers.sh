#!/usr/bin/env bash
# Self-test for check-headers.sh using good/bad fixtures.
set -u
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
CSP="default-src 'none'; script-src 'self' https://challenges.cloudflare.com; frame-ancestors 'none'; object-src 'none'; base-uri 'none'"
mk() { # name csp [hsts]
  printf 'HTTP/2 200\nstrict-transport-security: %s\ncontent-security-policy: %s\nx-frame-options: DENY\nx-content-type-options: nosniff\nreferrer-policy: no-referrer\npermissions-policy: camera=()\n' "${3:-max-age=31536000}" "$2" > "$tmp/$1"
}
rc=0
expect() { # want(0|1) name
  bash scripts/check-headers.sh --file "$tmp/$2" >/dev/null; got=$?
  if [ "$got" = "$1" ]; then echo "ok   $2"; else echo "FAIL $2 (exit $got, wanted $1)"; rc=1; fi
}
mk good "$CSP"; expect 0 good
mk wild "${CSP/script-src \'self\'/script-src *}"; expect 1 wild
mk inline "${CSP/script-src \'self\'/script-src \'self\' \'unsafe-inline\'}"; expect 1 inline
mk eval "${CSP/script-src \'self\'/script-src \'self\' \'unsafe-eval\'}"; expect 1 eval
mk defstar "default-src *; frame-ancestors 'none'; object-src 'none'; base-uri 'none'"; expect 1 defstar
mk nofa "default-src 'none'; object-src 'none'; base-uri 'none'"; expect 1 nofa
mk noobj "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"; expect 1 noobj
mk nobase "default-src 'none'; frame-ancestors 'none'; object-src 'none'"; expect 1 nobase
mk unquoted "default-src none; frame-ancestors none; object-src none; base-uri none"; expect 1 unquoted
mk lowhsts "$CSP" "max-age=300"; expect 1 lowhsts
: > "$tmp/empty"; expect 1 empty
exit $rc
