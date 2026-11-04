#!/bin/sh
# Test and build the fork, then pack a deploy bundle.
# Run on CT320 as admin, from a clean checkout of the branch to ship:
#   fork/build.sh            -> prints the bundle path (/tmp/seerr-bundle-<sha>.tar)
# NODE22 overrides the Node 22 bin directory (the tests need Node 22).
set -eu
cd "$(git rev-parse --show-toplevel)"
. fork/UPSTREAM

NODE22=${NODE22:-/home/admin/.local/node22/node_modules/node/bin}
# package.json scripts call pnpm themselves, so it has to be on PATH.
SHIMS=$(mktemp -d)
trap 'rm -rf "$SHIMS"' EXIT
corepack enable --install-directory "$SHIMS" pnpm
export PATH="$SHIMS:$NODE22:$PATH"
node --version | grep -q '^v22\.' || { echo "Node 22 required (set NODE22)" >&2; exit 1; }

if [ -n "$(git status --porcelain)" ]; then
  echo "working tree has uncommitted changes; commit first" >&2
  exit 1
fi
if ! git diff --quiet "$UPSTREAM_TAG" HEAD -- package.json pnpm-lock.yaml; then
  echo "package.json or pnpm-lock.yaml differ from $UPSTREAM_TAG." >&2
  echo "The image reuses upstream node_modules, so this build would be wrong." >&2
  echo "Update fork/UPSTREAM to the release you merged, or build a full image." >&2
  exit 1
fi

SHA=$(git rev-parse HEAD)
echo "== $SHA on $UPSTREAM_TAG"
pnpm typecheck
pnpm lint
pnpm test
rm -rf .next dist
# COMMIT_TAG goes into the client bundle. It must equal the server's commit,
# or every page load shows the "application updated, reload" dialog.
COMMIT_TAG=$SHA pnpm build

if ! grep -rqs "$SHA" .next/static; then
  echo "commit $SHA not found in the client bundle" >&2
  exit 1
fi

OUT=/tmp/seerr-bundle-$SHA.tar
STAGE=$(mktemp -d)
echo "$SHA" > "$STAGE/COMMIT"
cp fork/Dockerfile fork/UPSTREAM fork/deploy.sh fork/smoke.js fork/seerr-help-note "$STAGE/"
tar -cf "$OUT" --exclude=.next/cache .next dist seerr-api.yml -C "$STAGE" .
rm -rf "$STAGE"
echo "BUNDLE=$OUT"
