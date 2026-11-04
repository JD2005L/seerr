#!/bin/sh
# Build the image from a bundle, smoke-test it on a copy of the live config,
# then replace the running seerr container. Run on CT306 as root:
#   sh deploy.sh <unpacked-bundle-dir>          smoke test, then cut over
#   sh deploy.sh <unpacked-bundle-dir> --smoke  smoke test only
# On a failed health check it puts the previous container back by itself.
set -eu
DIR=$(cd "$1" && pwd)
MODE=${2:-deploy}
. "$DIR/UPSTREAM"
SHA=$(cat "$DIR/COMMIT")
SHORT=$(printf %.8s "$SHA")
IMAGE=local/seerr-fork:$SHORT
CONFIG=/docker/overseerr
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

copy_db() { # consistent copy of a live SQLite db, WAL included
  python3 - "$1" "$2" <<'EOF'
import sqlite3, sys
src = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
dst.close()
EOF
}

wait_ready() { # container, expected commit
  i=0
  while [ $i -lt 60 ]; do
    if docker exec "$1" node -e "fetch('http://127.0.0.1:5055/api/v1/status').then(r=>r.json()).then(s=>process.exit(s.commitTag===process.argv[1]?0:3)).catch(()=>process.exit(1))" "$2" 2>/dev/null; then
      return 0
    fi
    i=$((i + 1))
    sleep 3
  done
  return 1
}

echo "== build $IMAGE on $UPSTREAM_TAG"
docker build --pull=false --build-arg BASE_IMAGE="$BASE_IMAGE" \
  --build-arg SOURCE_COMMIT="$SHA" -t "$IMAGE" -f "$DIR/Dockerfile" "$DIR"

echo "== smoke test on a copy of the live config"
SMOKE=$DIR/smoke-config
rm -rf "$SMOKE"
mkdir -p "$SMOKE/db"
tar -C "$CONFIG" --exclude=./db --exclude=./logs -cf - . | tar -C "$SMOKE" -xf -
copy_db "$CONFIG/db/db.sqlite3" "$SMOKE/db/db.sqlite3"
chown -R 1000:1000 "$SMOKE"
docker rm -f "seerr-smoke-$SHORT" >/dev/null 2>&1 || true
docker run -d --name "seerr-smoke-$SHORT" --network none \
  -e TZ=America/Edmonton -v "$SMOKE:/app/config" "$IMAGE" >/dev/null
if ! wait_ready "seerr-smoke-$SHORT" "$SHA"; then
  docker logs --tail 40 "seerr-smoke-$SHORT" >&2
  docker rm -f "seerr-smoke-$SHORT" >/dev/null
  echo "SMOKE_FAIL candidate never became ready" >&2
  exit 1
fi
docker cp "$DIR/smoke.js" "seerr-smoke-$SHORT:/tmp/smoke.js"
if ! docker exec -e EXPECT_COMMIT="$SHA" "seerr-smoke-$SHORT" node /tmp/smoke.js; then
  docker rm -f "seerr-smoke-$SHORT" >/dev/null
  exit 1
fi
docker rm -f "seerr-smoke-$SHORT" >/dev/null
rm -rf "$SMOKE"
[ "$MODE" = "--smoke" ] && { echo "SMOKE_ONLY_DONE $IMAGE"; exit 0; }

echo "== back up live config"
BACKUP=/root/seerr-backup-$STAMP
mkdir -p "$BACKUP"
copy_db "$CONFIG/db/db.sqlite3" "$BACKUP/db.sqlite3"
cp -p "$CONFIG/settings.json" "$BACKUP/settings.json"
PREV=seerr-prev-$STAMP
PREV_IMAGE=$(docker inspect seerr --format '{{.Config.Image}}')
echo "previous image $PREV_IMAGE, kept as container $PREV, backup $BACKUP"

echo "== cut over"
docker stop seerr >/dev/null
docker rename seerr "$PREV"
docker update --restart no "$PREV" >/dev/null
docker run -d --name seerr --restart unless-stopped -p 5055:5055 \
  -e LOG_LEVEL=info -e TZ=America/Edmonton \
  -v "$CONFIG:/app/config" "$IMAGE" >/dev/null
if ! wait_ready seerr "$SHA"; then
  echo "new container not healthy, rolling back" >&2
  docker logs --tail 40 seerr >&2 || true
  docker rm -f seerr >/dev/null
  docker rename "$PREV" seerr
  docker update --restart unless-stopped seerr >/dev/null
  docker start seerr >/dev/null
  echo "DEPLOY_FAIL rolled back to $PREV_IMAGE" >&2
  exit 1
fi
# PVIBot's way to post progress on Notify PVIBot requests (see fork/README.md).
install -m 755 "$DIR/seerr-help-note" /usr/local/sbin/seerr-help-note
echo "DEPLOY_OK $IMAGE ($SHA)"
echo "rollback: docker rm -f seerr && docker rename $PREV seerr && docker update --restart unless-stopped seerr && docker start seerr"
