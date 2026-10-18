# Web TV app (LG webOS, Samsung Tizen, browser demo)

`apps/webtv` runs the desktop interface (`apps/desktop/src/renderer`) in a TV's web engine. It is a preview: it has
been tested at 1920×1080 with the remote's key codes, against the mock servers, in a current Edge and in Chromium 79
and 85 snapshots (the engines of webOS 6 and Tizen 6.5), never on a real TV.

- **Targets:** LG webOS 6 and later (2021+, Chromium 79 to 120) and Samsung Tizen 6.5 and later (2021+, Chromium 85
  and later). Older TVs would need more transpiling than is worth it.
- **Servers:** Emby and Jellyfin. Plex, file sources, IPTV and Immich are not in the TV app.
- **Not a release:** the packages are built by the `Web TV` workflow on every push to `main` and kept as workflow
  artifacts for 30 days. They are not attached to any GitHub Release.

## Try it

- **In a browser:** the `Web TV` workflow publishes a demo on the repository's GitHub Pages site
  (`https://<owner>.github.io/<repository>/`). The first visit opens signed in to the **Wicaby Demo** server as the
  user Wika, with a **Demo** badge in the corner; its **Connect your server** button opens the sources page, where
  the demo stays listed as a server found nearby (or type `demo` as the address). The demo server lives in the page: the Blender open movies
  with their CC BY artwork ([attribution](../tools/mock-server/demo/ATTRIBUTION.md)), and every title plays the same
  generated 30-second test clip, without sound. Watched state and favourites stay in that browser.
- **With your own server:** **Add** → server address, as on the desktop. From the Pages demo (an `https://` page),
  the browser only lets the app reach an `https://` server that accepts other web apps (see
  [Server requirements](#server-requirements)); a plain `http://` server on your network works from the TV app, not
  from the Pages site. The Pages demo shares the `<owner>.github.io` origin with every other Pages site of that
  account, so a real server's sign-in is kept for that browser tab only (`sessionStorage`) and is gone when the tab
  closes; sign out after testing anyway, or serve the demo from a custom domain used only by this app.
- **Turning the demo on (once, by the repository owner):** Settings → Pages → Build and deployment → Source:
  **GitHub Actions**. Until then the workflow's deploy job fails and the packages are still built. On a private
  repository Pages needs a paid plan.
- **The TV packages:** Actions → **Web TV** → the latest run → **Artifacts** → `wicaby-webtv-<commit>`. It holds
  `wicaby-webos-<version>.ipk` and `wicaby-tizen-<version>.wgt`.

## Build

```sh
npm ci
npm run build:webtv          # apps/webtv/dist/tv: the TV app (one classic script, Chromium 79 target)
npm run package:webtv        # apps/webtv/dist/packages: the .ipk and the unsigned .wgt
npm run build:webtv-demo     # apps/webtv/dist/demo: the Pages demo (builds its catalogue from the mock first)
npm run dev:webtv            # dev server on http://127.0.0.1:5299
npm run check:webtv          # svelte-check over the TV entry and the renderer it imports
```

- `apps/webtv/src/bridge.ts` answers `window.wicaby` in the page: settings, servers, sign-in, API calls, playback
  and the HTML player. What needs the desktop's main process (downloads, torrents, VPN, cast, file sources, IPTV,
  Plex, administration, live TV) is hidden through `lib/platform.ts` `web`, and its calls fail with "Not available in
  the TV app".
- Playback (`apps/webtv/src/playback.ts`) asks PlaybackInfo with the `tv` device profile of
  `apps/desktop/src/shared/device-profile.ts`, modelled on jellyfin-web's
  [browserDeviceProfile.js](https://github.com/jellyfin/jellyfin-web/blob/master/src/scripts/browserDeviceProfile.js):
  direct play of MP4, MKV and TS in H.264 or HEVC with AAC, AC3, EAC3, FLAC or Opus; anything else becomes an HLS
  transcode in H.264. DTS and TrueHD are transcoded; WebVTT and SRT are sent as files, ASS, SSA and image subtitles
  are burnt in by the server. In a desktop browser (the Pages demo) the desktop's `html` profile is used instead.
- The demo catalogue (`apps/webtv/scripts/demo-data.mjs`) is read from `tools/mock-server/mock-emby.mjs` with
  `MOCK_DATASET=demo` on 127.0.0.1; `apps/webtv/demo/demo.mp4` is a test pattern made with mpv (`testsrc`, no audio).

Checks: `tools/checks/webtv-check.mjs` (part of `npm run checks`: the `tv` profile, image URLs, the Back keys, the
auth header, log redaction, the demo server, the package layout) and `tools/checks/webtv-cdp.mjs` (not in run-all:
the demo and the TV build against the Emby and Jellyfin mocks in a headless Edge or Chrome at 1920×1080).

## Install on an LG TV (webOS)

**Developer Mode** (free LG account):

1. On the TV, install **Developer Mode** from the LG Content Store, sign in, turn on **Dev Mode Status** and
   **Key Server**, restart the TV.
2. On the computer: `npm install -g @webos-tools/cli`, then `ares-setup-device` (add the TV with the IP shown in the
   Developer Mode app) and `ares-novacom --device <name> --getkey` (passphrase from the app).
3. `ares-install --device <name> wicaby-webos-<version>.ipk`, then `ares-launch --device <name> com.wika.wicaby`.

A Developer Mode session lasts a limited time (up to 1,000 hours); extend it from the Developer Mode app. When it
runs out, the TV removes the apps installed this way.

**Homebrew Channel** ([webosbrew](https://github.com/webosbrew/webos-homebrew-channel)): it installs without root and
takes apps from package repositories (repo.webosbrew.org or one of your own). Publishing Wicaby there is a later
step; until then the `.ipk` goes in through Developer Mode as above.

## Install on a Samsung TV (Tizen)

The `.wgt` is **unsigned**: Samsung TVs only install a package signed with a certificate made for that TV (its DUID).

1. On the TV: **Apps**, type `12345` on the remote, turn **Developer mode** on and enter the computer's IP, restart.
2. On the computer: Tizen Studio (or its CLI) with the **Samsung Certificate Extension**; create a Samsung
   certificate profile for the TV (the Certificate Manager reads its DUID once connected: `sdb connect <tv-ip>`).
3. Unzip the `.wgt` into a folder, then `tizen package -t wgt -s <profile> -- <folder>` signs it, and
   `tizen install -n Wicaby.wgt -t <device>` installs it. Community tools that re-sign a `.wgt` for your TV work too.

The Tizen emulator conflicts with Hyper-V on Windows; the TV itself, or the browser demo, is the simpler test.

## Server requirements

The TV app calls the server straight from the TV's browser (the desktop goes through its main process), so the server
must accept cross-origin requests:

- **Jellyfin:** answers them by default.
- **Emby:** its own hosted web app (app.emby.media) relies on it, but an origin of `null` (a TV app loaded from
  `file://`) has not been tried against a real Emby yet. If sign-in fails with "The server didn't let this app in",
  this is the first suspect.
- **HTTPS:** older TVs carry old root certificates; a recent Let's Encrypt chain can be refused. Plain `http://` on
  the local network avoids that on the TV (not from the Pages demo, see above).

The sign-in token is kept in the TV's `localStorage` (the TV has no keychain; on the Pages demo in `sessionStorage`); the app's log never shows it
(`redact()` in `apps/webtv/src/http.ts`), and stream URLs carry it only to the server's own address.

## The remote

| Key | Does |
|---|---|
| Arrows, OK | Move the focus, open (spatial navigation, as on the desktop with a keyboard or a gamepad) |
| Back (LG 461, Samsung 10009) | Back; in the player, close the open panel, then stop. On Home, leave the app |
| Play, Pause, Play/Pause, Stop | Playback (Samsung's media keys are registered through `tvinputdevice`) |
| Fast forward, Rewind | +30 s, −10 s |
| Next, Previous (Samsung) | Next or previous item of the queue |

## The TV look

On a TV (or in any browser with `?tv=webos` in the address, for example the Pages demo) the page:

- draws the desktop layout at 1280×720 and scales it 1.5 times on a 1920×1080 screen (CSS `zoom` in
  `apps/webtv/src/tv.css`), so text and buttons are large enough at 3 m. `vh` and `vw` in the app's CSS go through
  `var(--vh)` and `var(--vw)`, because Chromium scales them by the zoom too;
- always shows a 3 px focus ring on the focused element, hides scrollbars and turns backdrop blur off.

The TV build's CSS goes through `apps/webtv/scripts/legacy-css.mjs`, because Chromium 79 to 87 drops a whole rule when
one of its selectors is unknown. It turns Svelte 5's `:where(.svelte-x)` scoping (Chromium 88) into plain classes,
`:focus-visible` (Chromium 86) into `:focus`, drops selectors with `:has()` (Chromium 105), folds `translate` and
`scale` (Chromium 104) into `transform`, expands `inset` (Chromium 87), and keeps scroll-driven animations (Chromium
115) behind `@supports`. The desktop build does not use it.

To check in an old engine, download a Chromium snapshot (79: build 706915, 85: build 782797, from
`storage.googleapis.com/chromium-browser-snapshots`) and run
`WEBTV_BROWSER=<path to its chrome.exe> node tools/checks/webtv-cdp.mjs`. Snapshots have no H.264, so the playback
checks are skipped there.

## Limits

- No mpv: what the TV's `<video>` cannot play is transcoded by the server. HDR, Dolby Vision, DTS passthrough and
  4K have not been checked on any TV; the profile asks for nothing the TV may not have.
- No downloads, torrents, VPN or mesh, cast, file sources, IPTV, Immich, Plex, live TV, music engine (gapless,
  ReplayGain), administration, intro skip, up next, quality sheet or trickplay in the TV app yet.
- Chromium 79 to 87: `aspect-ratio` is replaced by a script (`apps/webtv/src/aspect.ts`); flex `gap` (Chromium 84)
  is missing on webOS 6 and replaced by margins (`html.no-flex-gap`), so wrapped lines sit closer together; focus rings are square before Chromium 94;
  `color-mix()` colours fall back; selectors with `:has()` and container queries are dropped (a few hover effects,
  placeholder initials). Backdrop blur is off on TVs.
- An LG Content Store or Samsung Seller Office submission would need its own review pass (remote-only navigation,
  exit behaviour, store assets).
