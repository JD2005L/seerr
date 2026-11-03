#!/bin/sh
# Keeps Seerr on CT306 in step with the fork (github.com/JD2005L/seerr,
# branch levac) and with new upstream Seerr releases. Installed on pve1 as
# /usr/local/sbin/seerr-fork-update, run daily by seerr-fork-update.timer.
#
# Every run: sync the CT320 release clone to origin/levac; if upstream has a
# newer stable release, merge it and pin its image; if CT306 is not already
# running that commit, build (typecheck, lint, tests), smoke-test on a copy of
# live data, and cut over with automatic rollback. A merge conflict or any
# failed gate stops the run and production keeps what it was running.
# Upstream merges are pushed to GitHub only after they are live.
#
# Full output: /var/log/seerr-fork-update.log. Results worth knowing about go
# to /var/log/seerr-fork-update-events.jsonl, which PVIBot relays to Telegram.
set -u
BUILD_CT=${BUILD_CT:-320}
SEERR_CT=${SEERR_CT:-306}
CLONE=/home/admin/seerr-release
EVENTS=/var/log/seerr-fork-update-events.jsonl
LOG=/var/log/seerr-fork-update.log

exec 9>/run/seerr-fork-update.lock
flock -n 9 || { echo "another run is in progress"; exit 0; }

event() { # kind message
  python3 -c 'import json, sys, time
print(json.dumps({"id": "%d-%s" % (time.time(), sys.argv[1]),
  "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
  "kind": sys.argv[1], "message": sys.argv[2]}))' "$1" "$2" >> "$EVENTS"
  echo "EVENT $1: $2"
}
on_build() { pct exec "$BUILD_CT" -- su - admin -c "cd $CLONE && $1"; }
on_seerr() { pct exec "$SEERR_CT" -- sh -c "$1"; }
value() { sed -n "s/^$1=//p" | tail -1; }
short() { printf %.8s "$1"; }

echo "== $(date -u +%FT%TZ) start"
if ! out=$(on_build "fork/update.sh prepare" 2>&1); then
  echo "$out"
  event error "Seerr updater could not sync the fork on CT$BUILD_CT: $(echo "$out" | tail -2 | tr '\n' ' ')"
  exit 1
fi
echo "$out"
head=$(echo "$out" | value HEAD)
new_tag=$(echo "$out" | value NEW_TAG)
merged=""

if [ -n "$new_tag" ]; then
  echo "== upstream $new_tag"
  digest=$(on_seerr "docker pull -q ghcr.io/seerr-team/seerr:$new_tag >/dev/null && docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' ghcr.io/seerr-team/seerr:$new_tag" |
    sed -n 's|^ghcr.io/seerr-team/seerr@||p' | head -1)
  if [ -z "$digest" ]; then
    event error "Seerr $new_tag is tagged upstream but its image could not be pulled yet. Will retry next run."
    exit 1
  fi
  out=$(on_build "fork/update.sh merge $new_tag $digest" 2>&1)
  rc=$?
  echo "$out"
  if [ $rc -eq 2 ]; then
    event conflict "Seerr $new_tag needs a hand merge. Our changes conflict with it in: $(echo "$out" | sed -n 's/^CONFLICT=//p' | tr '\n' ' ')Production stays on $(short "$head"). Steps are in fork/README.md (Taking a new upstream release)."
    exit 1
  elif [ $rc -ne 0 ]; then
    on_build "fork/update.sh reset" >/dev/null 2>&1
    event error "Seerr updater could not merge $new_tag: $(echo "$out" | tail -2 | tr '\n' ' ')"
    exit 1
  fi
  head=$(echo "$out" | value HEAD)
  merged=$new_tag
fi

running=$(on_seerr "docker exec seerr node -e \"fetch('http://127.0.0.1:5055/api/v1/status').then(r=>r.json()).then(s=>console.log(s.commitTag))\"" 2>/dev/null)
if [ -n "$head" ] && [ "$running" = "$head" ]; then
  echo "== up to date at $head"
  exit 0
fi
echo "== running ${running:-unknown}, building $head"

out=$(on_build "fork/build.sh" 2>&1)
rc=$?
echo "$out" | tail -60
if [ $rc -ne 0 ]; then
  [ -n "$merged" ] && on_build "fork/update.sh reset" >/dev/null 2>&1
  event build_failed "Seerr build of $(short "$head")${merged:+ (upstream $merged)} failed: $(echo "$out" | grep -E 'not ok|✖|[Ee]rror' | grep -v '0 errors' | tail -3 | tr '\n' ' ')Production unchanged. Log: $LOG on pve1."
  exit 1
fi
bundle=$(echo "$out" | value BUNDLE)
dir=/root/seerr-bundle-$head
if ! pct exec "$BUILD_CT" -- cat "$bundle" |
  pct exec "$SEERR_CT" -- sh -c "rm -rf $dir && mkdir -p $dir && tar -C $dir -xf -"; then
  [ -n "$merged" ] && on_build "fork/update.sh reset" >/dev/null 2>&1
  event error "Seerr updater could not copy the build to CT$SEERR_CT. Production unchanged."
  exit 1
fi
pct exec "$BUILD_CT" -- rm -f "$bundle"

out=$(on_seerr "sh $dir/deploy.sh $dir" 2>&1)
rc=$?
echo "$out" | tail -60
if [ $rc -ne 0 ]; then
  [ -n "$merged" ] && on_build "fork/update.sh reset" >/dev/null 2>&1
  event deploy_failed "Seerr $(short "$head")${merged:+ (upstream $merged)} failed its smoke test or health check, so production stays on $(short "$running"). $(echo "$out" | grep -E 'SMOKE_FAIL|DEPLOY_FAIL' | tail -1)"
  exit 1
fi

if [ -n "$merged" ]; then
  if on_build "fork/update.sh push"; then
    event updated "Seerr is now on upstream $merged with our changes ($(short "$head")). Tests, smoke test and health check passed."
  else
    event push_failed "Seerr $merged is live ($(short "$head")) but pushing levac to GitHub failed. The next run will redo the merge."
  fi
else
  event deployed "Seerr fork commit $(short "$head") is live. Tests, smoke test and health check passed."
fi

# Keep one previous container for rollback; drop older ones and their images.
on_seerr "rm -rf $dir
  for c in \$(docker ps -a --format '{{.Names}}' | grep '^seerr-prev-' | sort | head -n -1); do docker rm \$c >/dev/null; done
  used=\$(docker ps -a --format '{{.Image}}' | sort -u)
  for i in \$(docker images --format '{{.Repository}}:{{.Tag}}' local/seerr-fork); do echo \"\$used\" | grep -qx \"\$i\" || docker rmi \$i >/dev/null; done
  docker image prune -f >/dev/null"
echo "== $(date -u +%FT%TZ) done"
