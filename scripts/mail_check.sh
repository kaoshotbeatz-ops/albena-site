#!/usr/bin/env bash
# Checks email-authentication DNS for the sending domain. Usage: scripts/mail_check.sh [domain] [bounce-subdomain]
# Exit status is the number of failed checks.
set -u
D="${1:-albena.ai}"; B="${2:-cf-bounce.$D}"; DKIM_SEL="${DKIM_SELECTOR:-cf-bounce}"
fail=0
txt() { dig +short TXT "$1" | tr -d '"' | tr '\n' ' '; }
ok()  { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fail=$((fail+1)); }
note(){ printf 'NOTE  %s\n' "$1"; }
command -v dig >/dev/null || { echo "dig not found" >&2; exit 99; }

mx=$(dig +short MX "$B"); [ -n "$mx" ] && ok "MX $B -> $(echo $mx | tr '\n' ' ')" || bad "MX $B missing (bounce handling)"
sp=$(txt "$B"); case "$sp" in *v=spf1*) ok "SPF $B: $sp";; *) bad "SPF $B missing";; esac
case "$sp" in *"-all"*|*"~all"*) ok "SPF $B ends with an all-mechanism";; *) bad "SPF $B has no -all/~all";; esac

dk=$(txt "$DKIM_SEL._domainkey.$D"); case "$dk" in *p=*) ok "DKIM $DKIM_SEL._domainkey.$D present";; *) bad "DKIM $DKIM_SEL._domainkey.$D missing (set DKIM_SELECTOR=... if different)";; esac

dm=$(txt "_dmarc.$D")
case "$dm" in
  *v=DMARC1*) ok "DMARC: $dm"
    case "$dm" in *p=quarantine*|*p=reject*) ok "DMARC policy enforces";; *) bad "DMARC policy is none";; esac
    case "$dm" in *onsecureserver.net*) bad "DMARC rua still points at leftover GoDaddy address";; esac
    case "$dm" in *rua=*) ok "DMARC has rua reporting";; *) bad "DMARC has no rua";; esac;;
  *) bad "DMARC _dmarc.$D missing";;
esac

root=$(txt "$D" | grep -o 'v=spf1[^"]*')
if [ -n "$root" ]; then
  case "$root" in *"-all"*) ok "Root SPF: $root";; *) bad "Root SPF not locked to -all: $root";; esac
else
  bad "Root SPF missing (propose \"v=spf1 -all\" if apex sends no mail)"
fi
dig +short MX "$D" | grep -q . && note "Apex has MX records (inbound mail provider); keep root SPF in sync with it" || note "Apex has no MX (expected if no inbound mail yet)"

echo; [ "$fail" -eq 0 ] && echo "All checks passed" || echo "$fail check(s) failed"
exit "$fail"
