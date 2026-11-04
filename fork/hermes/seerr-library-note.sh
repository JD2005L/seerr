#!/bin/sh
# PVIBot (Hermes, CT321) reports progress on a Seerr "Notify PVIBot" request.
# The person who pressed it sees the last 3 notes in Seerr.
# Installed as /root/.hermes/scripts/seerr-library-note.sh.
#
#   seerr-library-note.sh <help id> <investigating|resolving|resolved|needs_james> "<note>"
#
# Notes: plain words, under 80 characters. Seerr keeps 200 at most.
set -eu
id=${1:-}
status=${2:-}
note=${3:-}
case "$id" in '' | *[!0-9]*)
  echo "help id must be a number" >&2
  exit 2
  ;;
esac
case "$status" in
investigating | resolving | resolved | needs_james) ;;
*)
  echo "status must be investigating, resolving, resolved or needs_james" >&2
  exit 2
  ;;
esac
body=$(python3 -c 'import json, sys; print(json.dumps({"status": sys.argv[1], "note": sys.argv[2][:200]}))' "$status" "$note" | base64 -w0)
exec "$(dirname "$0")/pve.sh" ct 306 "/usr/local/sbin/seerr-help-note $id $body"
