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
  `src/components/RequestButton/`, `server/constants/fanout.ts` (stage rules
  and plain-language reasons, shared by the page and the PVIBot message).
- **Library progress and Notify PVIBot.** Each add or removal gets one live
  message that updates in place until it is done, failed, or still waiting
  after 10 minutes, and the menu says where each library stands ("Adding
  to William's Library...", "Retry ..."). For a failed, slow or unsaved
  change the person can press Notify PVIBot. See below.
- **Problem reports go to PVIBot.** Every new "Report an Issue", a
  comment from its reporter, and a reopen is sent to PVIBot as a signed
  `seerr_issue` event (`server/lib/issueRelay.ts`, through `levacEvents.ts`;
  one retry after a minute; no `eventsUrl` = nothing sent). Comments starting
  "PVIBot:" are never relayed. PVIBot answers with `seerr-issue-note <id>
  <comment|resolve> <base64 json>` on CT306 (`fork/seerr-issue-note`,
  installed by every deploy), so Seerr's own notifications tell the reporter.
- **Request menu order and scrolling.** Libraries the title is already in go
  last in the request menu, below a separator (`menuGroups` in
  `fanoutOptions.ts`). `Common/ButtonWithDropdown` opens its menu with
  `modal={false}` and a 75vh cap: Headless UI 2 menus lock page scrolling
  by default, so a long menu that ran off the screen could not be reached.
  This shared component is the likeliest place for an upstream merge
  conflict.
- **Request As picks the destination.** Each person's Radarr/Sonarr server,
  profile, root folder and tags come from their override rule. The request
  modal fills them in when an admin changes Request As, and the server applies
  the same mapping when the request is created (`applyDestination`).
- **Request modal.** Root Folder and Tags are hidden (still submitted).
  Regular users see who the request is for as plain text; only admins get the
  Request As picker.
- **Show requests without a search (`skipSearch`).** A show request made with
  `skipSearch: true` goes to Sonarr without Seerr's series search, whatever
  the server's automatic search setting; every other request keeps it. Levac
  TV asks for shows an episode at a time: the Media Pipeline (CT326) then has
  Sonarr watch only the episodes asked for and searches for those. Its seasons
  also go to Sonarr unwatched (new shows get `monitorNewItems: none`), so
  Sonarr's RSS check can't grab a whole season before the pipeline marks the
  episodes asked for; for a show Sonarr already has, its seasons stay as they
  were instead of being re-watched. The flag
  is on the entity during creation (the auto-approved hand-off happens in the
  same save) and in the `media_request_nosearch` table for later approvals and
  re-sends. Code: `server/lib/noSearch.ts`, `MediaRequest.request()`,
  `MediaRequestSubscriber.sendToSonarr()`, `seerr-api.yml`.
- **Quality profile.** A regular user's chosen profile is kept instead of
  being replaced by their override rule (`server/entity/MediaRequest.ts`).
- API spec entries for the new endpoints (`seerr-api.yml`).
- **Discover per person.** For anyone who doesn't manage requests, "Recently
  Added" lists what arrived in the Plex libraries they have (their own plus
  what Plex shares with them, newest copy first), and "Recent Requests" and
  the Requests page their own requests plus those going to those libraries
  (by root folder `/library/<owner>`). The server owner and request managers
  still see everything. Library contents come from the Plex server and
  sharing from plex.tv's `shared_servers` list, cached; when Plex can't be
  reached a person sees only their own requests, never everyone's. Code:
  `server/lib/libraryAccess.ts`, used by `GET /media?sort=mediaAdded` and
  `GET /request`. Titles they can't see can still be added to their library
  with "Add to My Library" (the fan-out above).
- **Levac TV branding.** `logo_stacked.svg` (login, setup, password reset)
  and `logo_full.svg` (sidebar) are the wordmark from the Levac TV app's
  "Who's watching?" screen (LevacTV `ProfilesScreen.kt`, `Wordmark()`):
  "LEVAC" in the app's Inter at Black with wide spacing and a silver
  gradient, then a glowing Sky (`#4FC3F7`) "TV" badge, drawn as outlines from
  the app's own font file. Favicons and home-screen icons are the app's
  launcher house on its dark tile, drawn with depth; the iOS splash screens
  carry the wordmark; the missing-poster images a flat muted house. All of it
  comes from `fork/branding/brand.py` (how to run it is at its top). If the
  app's wordmark changes, change the numbers there to match. If an upstream
  merge conflicts on one of these files, keep ours, then re-run the script in
  case upstream added a new size. The background poster rotation is
  upstream's and untouched. These files reach the image because `build.sh`
  bundles `public/` and the Dockerfile copies it over upstream's.

## Notify PVIBot

```
Seerr (CT306) --POST, X-Seerr-Key--> n8n "MEDIA - Seerr library help to Hermes"
  (192.168.10.12, /webhook/seerr/library-help) --signed body as is-->
  Hermes webhook route seerr-library (CT321 :8644) --> PVIBot, then Telegram
PVIBot --seerr-library-note.sh--> pve.sh ct 306 seerr-help-note --> Seerr API
```

- `POST /request/fanout/help` saves the request in `media_fanout_help`, then
  sends the title, library, what the person saw, the copy worker's status and
  error, and the title's intent rows. The body is signed for Hermes's generic
  webhook check (hex HMAC-SHA256 of `<timestamp>.<body>`); n8n checks the key
  header and forwards the body byte for byte. A failed send is kept as
  `send_failed` and the page tells the person to let James know.
- PVIBot posts progress with `/root/.hermes/scripts/seerr-library-note.sh <id>
  <investigating|resolving|resolved|needs_james> "<note>"`
  (`fork/hermes/seerr-library-note.sh`). That runs
  `/usr/local/sbin/seerr-help-note` on CT306 (`fork/seerr-help-note`,
  installed by every deploy), which calls
  `POST /request/fanout/help/:id/note` with Seerr's own API key. The page
  shows the last 3 notes.
- Settings live in `/docker/overseerr/levac-notify.json` on CT306
  (`{"url", "key", "hermesSecret"}`, mode 600, owner 1000). `key` must match
  the n8n workflow's check and `hermesSecret` the `seerr-library` route's
  secret in `/root/.hermes/webhook_subscriptions.json` (mode 600). The route's
  prompt tells PVIBot how the copy worker works and what it may fix.
- TV shows: Sonarr usually holds no episode files here, so the copy worker
  finds them through Plex (`plexShowForFanout`, added 2026-11-04), as it does
  for movies.

## Branches

- `levac`: production. Upstream release tag + our commits, merged forward.
- `develop`: upstream's branch, untouched.
- `upstream` remote: https://github.com/seerr-team/seerr.

## Automatic updates

`seerr-fork-update.timer` on pve1 runs `/usr/local/sbin/seerr-fork-update`
(copy of `fork/pve1-update.sh`) every day at 04:30 Edmonton time:

1. Syncs the release clone on CT320 (`/home/admin/seerr-release`, automation
   only, reset to `origin/levac` every run) and installs dependencies.
2. If upstream has a newer stable release (`vX.Y.Z`), pulls its image on
   CT306, merges the tag into `levac` and pins the image digest in
   `fork/UPSTREAM` (`fork/update.sh merge`).
3. If CT306 is not already running that commit: `fork/build.sh`, then
   `fork/deploy.sh` (smoke test on a copy of live data, cut over, automatic
   rollback).
4. Pushes an upstream merge to GitHub only once it is live.

So anything pushed to `levac` on GitHub goes live the next morning, and so
does each upstream release that merges cleanly and passes every gate. A
merge conflict or any failed gate stops the run; production keeps what it
was running. Results land in `/var/log/seerr-fork-update-events.jsonl` on
pve1, and PVIBot relays them to James on Telegram
(`fork/hermes/check_seerr_fork_update_events.py`, Hermes cron job
`seerr-fork-update-events`). Full output: `/var/log/seerr-fork-update.log`.

Run it now: `systemctl start seerr-fork-update` on pve1 (takes ~15 minutes).
Pause it: `systemctl disable --now seerr-fork-update.timer`.

Install or refresh on pve1 from a checkout:
`install -m 755 fork/pve1-update.sh /usr/local/sbin/seerr-fork-update` and
`install -m 644 fork/systemd/* /etc/systemd/system/`, then
`systemctl daemon-reload && systemctl enable --now seerr-fork-update.timer`.

## Taking a new upstream release by hand

Needed when the updater reports a conflict. On CT320 as admin, in
`/opt/project-workbench/workspaces/seerr` (not the release clone):

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
