# Levac Seerr fork

This is the Seerr that runs at https://requests.levac.net (pve1 CT306). It is
upstream Seerr plus our changes, built from this repository. Nothing is
patched inside a running container any more.

## Why this exists

Until November 2026 our changes were string patches applied to the compiled
files inside the stock `ghcr.io/seerr-team/seerr:latest` container, re-applied
by two systemd timers on CT306. On 2026-10-30 Watchtower pulled a new image,
the patches no longer matched the compiled code, and the custom UI vanished
without anyone noticing. The fix is to keep the changes in source, pin the
upstream base, and only ship a build that has passed tests.

Retired on CT306, do not re-enable: `seerr-fanout-patch.timer`,
`seerr-custom-patches.timer` (they rewrite compiled files and would break this
build), and the `watchtower` container (it only watched Seerr).

## What is ours

`git diff v3.5.1 levac` (or whatever `fork/UPSTREAM` says) shows all of it:

- **My Library fan-out.** On an available title, "Add to My Library" /
  "Remove from My Library", plus a per-person menu for admins. Seerr only
  records the wish in `media_fanout_intent`; the CT312 media routing watchdog
  (`/opt/mcp-tools/scripts/media-routing-watchdog.mjs`, every 2 minutes) does
  the actual add or remove and writes back `fulfilled` / `removed` / `error`.
  Code: `server/lib/fanout.ts`, `server/routes/request.ts`,
  `src/components/RequestButton/`.
- **Request As picks the destination.** Each person's Radarr/Sonarr server,
  profile, root folder and tags come from their override rule. The request
  modal fills them in when an admin changes Request As, and the server applies
  the same mapping when the request is created (`applyDestination`).
- **Request modal.** Root Folder and Tags are hidden (still submitted).
  Regular users see who the request is for as plain text; only admins get the
  Request As picker.
- **Quality profile.** A regular user's chosen profile is kept instead of
  being replaced by their override rule (`server/entity/MediaRequest.ts`).
- API spec entries for the new endpoints (`seerr-api.yml`).

## Branches

- `levac`: production. Upstream release tag + our commits, merged forward.
- `develop`: upstream's branch, untouched.
- `upstream` remote: https://github.com/seerr-team/seerr.

## Taking a new upstream release

On CT320 as admin, in `/opt/project-workbench/workspaces/seerr`:

1. `git fetch upstream --tags`
2. `git checkout levac && git merge vX.Y.Z` and resolve conflicts. Keep both
   sides' intent; our changes are small and listed above.
3. Set `UPSTREAM_TAG` in `fork/UPSTREAM` to `vX.Y.Z` and `BASE_IMAGE` to that
   release's digest (`docker pull ghcr.io/seerr-team/seerr:vX.Y.Z` on CT306,
   then `docker image inspect --format '{{json .RepoDigests}}'`). Commit.
4. Build and deploy as below. `build.sh` stops if our dependencies differ from
   the release (the image reuses upstream's `node_modules`).
5. `git push origin levac`.

## Build and deploy

The checkout is owned by `admin`; Node 22 lives in `~/.local/node22`.

```sh
# CT320, as admin: tests, typecheck, lint, build, bundle
fork/build.sh                      # prints BUNDLE=/tmp/seerr-bundle-<sha>.tar

# pve1: copy the bundle to CT306
pct exec 320 -- cat /tmp/seerr-bundle-<sha>.tar | pct exec 306 -- sh -c 'mkdir -p /root/seerr-bundle-<sha> && tar -C /root/seerr-bundle-<sha> -xf -'

# CT306, as root: build image, smoke test on a copy of live data, cut over
sh /root/seerr-bundle-<sha>/deploy.sh /root/seerr-bundle-<sha> --smoke   # optional dry run
sh /root/seerr-bundle-<sha>/deploy.sh /root/seerr-bundle-<sha>
```

`deploy.sh` backs up the database and `settings.json` to
`/root/seerr-backup-<time>`, keeps the old container as `seerr-prev-<time>`,
and rolls back by itself if the new one does not report the expected commit.
It prints the manual rollback command at the end. Remove old `seerr-prev-*`
containers and `local/seerr-fork:*` images once a release has settled.

Long steps (`build.sh` takes ~10 minutes, `deploy.sh` a few) should run under
`setsid nohup ... > log 2>&1 &` when started through a remote shell that times
out.
