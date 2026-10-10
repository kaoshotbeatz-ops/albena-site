#!/usr/bin/env bash
# ALB-SEC-1 emergency bypass ("break glass") for branch protection that binds the owner (enforce_admins).
#
#   scripts/break-glass.sh --repo albena-site|albena --reason "why" [--minutes 30] [--change CHG1234]
#   scripts/break-glass.sh --restore --repo albena-site|albena      (restore now; also what the watchdog runs)
#   scripts/break-glass.sh --status                                 (show enforce_admins for both repos)
#
# What it does, in order (stops at the first failure, nothing changed until step 4):
#   1. Factor 1: Omar's PIN, read from the terminal (never argv/env), checked with pin_ok() from
#      ~/Scripts/webdev_gateway.py (scrypt hash in ~/.config/webdev-gateway/pin.json).
#   2. Factor 2: fresh GitHub re-authentication (`gh auth refresh`, browser/device flow with GitHub 2FA),
#      then confirms the token belongs to the repo owner account.
#   3. Records the bypass BEFORE lifting it: an audit_log row in the albena.ai D1 audit chain
#      (action github.break_glass.start; sealed into the hash chain on the next audit write) and a
#      warning event in Obvera Event Management, plus an ailog line.
#   4. Lifts enforce_admins on main (required checks/linear history then no longer bind admins).
#   5. Starts a detached watchdog that restores protection after --minutes even if this terminal dies,
#      and restores immediately when you press Enter or the script exits (trap).
#   6. Restore re-enables enforce_admins, verifies it, and records github.break_glass.end the same way.
#
# Only the owner can run it: it needs the PIN, a GitHub re-login, and local wrangler + Obvera credentials.
set -euo pipefail

OWNER_LOGIN="kaoshotbeatz-ops"
ORG="kaoshotbeatz-ops"
BRANCH="main"
GATEWAY="$HOME/Scripts/webdev_gateway.py"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$HOME/.local/state/albena-break-glass"; mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"

REPO=""; REASON=""; MINUTES=30; CHANGE=""; MODE="open"
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?}"; shift 2 ;;
    --reason) REASON="${2:?}"; shift 2 ;;
    --minutes) MINUTES="${2:?}"; shift 2 ;;
    --change) CHANGE="${2:?}"; shift 2 ;;
    --restore) MODE="restore"; shift ;;
    --status) MODE="status"; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

die() { echo "BREAK-GLASS STOPPED: $*" >&2; exit 1; }
api_enforce() { gh api "repos/$ORG/$1/branches/$BRANCH/protection/enforce_admins" --jq .enabled 2>/dev/null || echo "unknown"; }

if [ "$MODE" = status ]; then
  for r in albena-site albena; do echo "$r@$BRANCH enforce_admins=$(api_enforce "$r")"; done
  exit 0
fi

case "$REPO" in albena-site|albena) ;; *) die "--repo must be albena-site or albena" ;; esac

# Records one event in the D1 audit chain (unsealed insert; the next audit() call seals it into the chain),
# in Obvera Event Management, and in ailog. Fails closed on the D1 write for "start".
record() { # action severity message
  local action="$1" sev="$2" msg="$3" rid target
  rid="$(uuidgen | tr 'A-Z' 'a-z')"
  target="$(printf '%s' "$ORG/$REPO@$BRANCH; $msg" | tr -d "'" | cut -c1-480)"
  ( cd "$ROOT/worker" && npx --yes wrangler d1 execute albena --remote --command \
      "INSERT INTO audit_log (actor, action, target, request_id) VALUES ('$OWNER_LOGIN:break-glass', '$action', '$target', '$rid')" >/dev/null ) \
    || return 1
  python3 - "$sev" "$action" "$target" <<'PY' || echo "warning: Obvera event not delivered (audit row was written)" >&2
import sys; sys.path.insert(0, __import__("os").path.expanduser("~/Scripts"))
import obvera_client as o
sev, action, target = sys.argv[1:4]
o.api("POST", "eventhub/ingest", {"source": "albena-break-glass", "node": "github", "type": action, "severity": sev,
      "message": target, "dedupe_key": "albena-break-glass:" + target.split(";")[0], **({"status": "resolved"} if action.endswith(".end") else {})})
PY
  command -v ailog >/dev/null && ailog add claude "BREAK-GLASS $action: $target" >/dev/null 2>&1 || true
}

restore() {
  local now
  now="$(api_enforce "$REPO")"
  if [ "$now" != "true" ]; then
    gh api -X POST "repos/$ORG/$REPO/branches/$BRANCH/protection/enforce_admins" >/dev/null || die "could not restore enforce_admins on $REPO (do it by hand NOW)"
  fi
  [ "$(api_enforce "$REPO")" = "true" ] || die "enforce_admins on $REPO is not true after restore"
  if [ -f "$STATE_DIR/$REPO.open" ]; then
    record "github.break_glass.end" info "protection restored (enforce_admins=true); opened $(cat "$STATE_DIR/$REPO.open")" || echo "warning: end audit row not written" >&2
    rm -f "$STATE_DIR/$REPO.open"
  fi
  [ -f "$STATE_DIR/$REPO.watchdog" ] && { kill "$(cat "$STATE_DIR/$REPO.watchdog")" 2>/dev/null || true; rm -f "$STATE_DIR/$REPO.watchdog"; }
  echo "restored: $ORG/$REPO@$BRANCH enforce_admins=true"
}

if [ "$MODE" = restore ]; then restore; exit 0; fi

[ "${#REASON}" -ge 10 ] || die "--reason is required (at least 10 characters)"
[[ "$MINUTES" =~ ^[0-9]+$ ]] && [ "$MINUTES" -ge 1 ] && [ "$MINUTES" -le 60 ] || die "--minutes must be 1..60"
[ -t 0 ] || die "must be run interactively (PIN prompt)"
[ -f "$STATE_DIR/$REPO.open" ] && die "a bypass is already open for $REPO (run --restore)"

# 1. Factor 1: PIN (stdin of a python child, never on the command line).
printf 'Omar PIN: '; IFS= read -rs PIN; echo
printf '%s' "$PIN" | python3 -c '
import importlib.util, sys
spec = importlib.util.spec_from_file_location("gw", sys.argv[1]); gw = importlib.util.module_from_spec(spec); spec.loader.exec_module(gw)
sys.exit(0 if gw.pin_ok(sys.stdin.read()) else 1)' "$GATEWAY" || { unset PIN; die "wrong PIN"; }
unset PIN

# 2. Factor 2: fresh GitHub login (GitHub enforces its own 2FA in the browser/device flow).
echo "Factor 2: GitHub re-authentication (a browser/device prompt follows)."
gh auth refresh -h github.com -s repo || die "GitHub re-authentication failed"
[ "$(gh api user --jq .login)" = "$OWNER_LOGIN" ] || die "GitHub token is not the owner account $OWNER_LOGIN"

# 3. Record first; refuse to lift anything if the audit chain write fails.
OPENED="$(date -u +%Y-%m-%dT%H:%M:%SZ) for ${MINUTES}m; reason: $REASON${CHANGE:+; change $CHANGE}"
record "github.break_glass.start" warning "enforce_admins lifted $OPENED" || die "audit chain write failed; protection NOT lifted"
printf '%s' "$OPENED" > "$STATE_DIR/$REPO.open"

# 4 + 5. Lift, with an exit trap and a detached watchdog as two independent restore paths.
trap 'restore' EXIT INT TERM HUP
gh api -X DELETE "repos/$ORG/$REPO/branches/$BRANCH/protection/enforce_admins" >/dev/null || die "could not lift enforce_admins"
nohup bash -c "sleep $((MINUTES * 60)); '$0' --restore --repo '$REPO'" >"$STATE_DIR/$REPO.watchdog.log" 2>&1 &
echo $! > "$STATE_DIR/$REPO.watchdog"
echo "OPEN: $ORG/$REPO@$BRANCH no longer binds admins for up to $MINUTES min (watchdog pid $(cat "$STATE_DIR/$REPO.watchdog"))."
echo "Do the emergency merge/push in another terminal, then press Enter here to restore."
read -r -t $((MINUTES * 60)) _ || true
# EXIT trap restores and records the end entry.
