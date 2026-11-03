#!/bin/sh
# Release-clone side of the automatic updater (pve1 runs fork/pve1-update.sh,
# which calls this). Run on CT320 as admin in /home/admin/seerr-release, a
# clone that only automation uses: it is reset to origin/levac every run, so
# never edit it by hand. Develop in the ProjectWorkbench workspace and push.
#   fork/update.sh prepare           sync to origin/levac, install deps;
#                                    prints HEAD=<sha> and NEW_TAG=<tag> if a
#                                    newer stable upstream release exists
#   fork/update.sh merge TAG DIGEST  merge TAG, pin DIGEST in fork/UPSTREAM,
#                                    commit; exit 2 on conflicts (aborted)
#   fork/update.sh push              push levac to origin
#   fork/update.sh reset             drop local commits (back to origin/levac)
set -eu
cd "$(git rev-parse --show-toplevel)"
NODE22=${NODE22:-/home/admin/.local/node22/node_modules/node/bin}

pnpm_path() {
  SHIMS=$(mktemp -d)
  trap 'rm -rf "$SHIMS"' EXIT
  corepack enable --install-directory "$SHIMS" pnpm
  export PATH="$SHIMS:$NODE22:$PATH"
}

case "${1:-}" in
prepare)
  git fetch -q origin
  git fetch -q --tags upstream
  git checkout -q levac
  git reset -q --hard origin/levac
  git clean -qfdx -e node_modules
  pnpm_path
  pnpm install --frozen-lockfile --reporter=silent
  . fork/UPSTREAM
  echo "HEAD=$(git rev-parse HEAD)"
  # Newest stable release (vX.Y.Z only, no pre-releases) not yet merged.
  latest=$(git tag -l 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
  if [ -n "$latest" ] && [ "$latest" != "$UPSTREAM_TAG" ] &&
    ! git merge-base --is-ancestor "$latest" HEAD; then
    echo "NEW_TAG=$latest"
  fi
  ;;
merge)
  tag=$2
  digest=$3
  case "$digest" in sha256:*) ;; *) echo "bad digest $digest" >&2; exit 1 ;; esac
  # HUSKY=0: the commit hooks want a terminal, and nobody is at one.
  if ! HUSKY=0 git merge -q --no-edit -m "chore: merge upstream $tag" "$tag"; then
    git diff --name-only --diff-filter=U | sed 's/^/CONFLICT=/'
    git merge --abort
    exit 2
  fi
  cat > fork/UPSTREAM <<EOF
# Upstream Seerr release this branch is built on. The image reuses that
# release image's node_modules, so build.sh refuses to build when
# package.json or pnpm-lock.yaml differ from this tag.
UPSTREAM_TAG=$tag
BASE_IMAGE=ghcr.io/seerr-team/seerr@$digest
EOF
  git add fork/UPSTREAM
  HUSKY=0 git commit -q -m "chore: build on upstream $tag" \
    -m "Pinned base image ghcr.io/seerr-team/seerr:$tag ($digest). Merged and committed by fork/update.sh."
  pnpm_path
  pnpm install --frozen-lockfile --reporter=silent
  echo "HEAD=$(git rev-parse HEAD)"
  ;;
push)
  git push -q origin levac
  echo "PUSHED=$(git rev-parse HEAD)"
  ;;
reset)
  git merge --abort 2>/dev/null || true
  git reset -q --hard origin/levac
  ;;
*)
  sed -n '2,13p' "$0"
  exit 1
  ;;
esac
