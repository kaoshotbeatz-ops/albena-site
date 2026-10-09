#!/usr/bin/env bash
# TLS posture check (NIST SC-8/SC-13/RA-5). Usage: scripts/check-tls.sh <host> [port]
# Requires sslyze (pip install sslyze). Fails if TLS 1.0/1.1/SSLv2/3 accepted, or if no TLS 1.2+ suite is accepted,
# or if any accepted TLS 1.2 suite is weak (NULL/EXPORT/RC4/DES/3DES/MD5/anon).
set -uo pipefail
HOST="${1:?usage: check-tls.sh <host> [port]}"; PORT="${2:-443}"
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
# sslyze exits non-zero on Mozilla-profile non-compliance; we apply our own policy below, so only require output.
sslyze --json_out="$tmp" "$HOST:$PORT" >/dev/null 2>&1
[ -s "$tmp" ] || { echo "FAIL: sslyze could not scan $HOST:$PORT"; exit 1; }
python3 - "$tmp" <<'PY'
import json, re, sys
d = json.load(open(sys.argv[1]))
res = d["server_scan_results"][0]["scan_result"]
fail = 0
def accepted(key):
    r = res.get(key)
    if not r or r.get("status") != "COMPLETED":
        return []
    return [c["cipher_suite"]["name"] for c in r["result"].get("accepted_cipher_suites", [])]
for key, name in (("ssl_2_0_cipher_suites","SSLv2"),("ssl_3_0_cipher_suites","SSLv3"),("tls_1_0_cipher_suites","TLS1.0"),("tls_1_1_cipher_suites","TLS1.1")):
    a = accepted(key)
    if a: print(f"FAIL: {name} accepted ({len(a)} suites)"); fail = 1
    else: print(f"PASS: {name} not accepted")
t12, t13 = accepted("tls_1_2_cipher_suites"), accepted("tls_1_3_cipher_suites")
if not (t12 or t13): print("FAIL: no TLS 1.2/1.3 suites accepted"); fail = 1
else: print(f"PASS: TLS1.2={len(t12)} suites, TLS1.3={len(t13)} suites")
weak = re.compile(r"NULL|EXPORT|RC4|DES|MD5|anon", re.I)
bad = [c for c in t12 if weak.search(c)]
if bad: print("FAIL: weak TLS1.2 suites accepted: " + ", ".join(bad)); fail = 1
else: print("PASS: no weak TLS1.2 suites")
sys.exit(fail)
PY
