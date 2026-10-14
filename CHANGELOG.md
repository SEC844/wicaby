<!--
  MAINTAINER NOTE (staging draft; delete this comment before publishing).
  Before tagging v0.2.0:
  - fill in the dependency upgrades below (the TODO comment under "Changed");
  - clear the release blockers listed at the top of THIRD_PARTY_NOTICES.md and SECURITY.md.
-->

# Changelog

All notable changes to Wicaby are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Wicaby is versioned as a whole: a release tag (`vX.Y.Z`) covers the Windows desktop app, the
Android TV app, the Android mobile app and the mesh helper. The Android apps also carry their own
`versionName` and `versionCode` (used by the in-app updater); they are listed in each entry.

## [Unreleased]

## [0.10.4] - 2026-10-14

Covers on Emby albums without art, a new music library and a Sources screen. Windows and Linux desktop **0.10.4**,
Android TV app **0.10.4** (`versionCode` 25), Android mobile app **0.10.4** (`versionCode` 22).

### Fixed

- Android TV and mobile: comic covers from an Emby server show again. Emby answers a request for the last bytes of a
  file (`Range: bytes=-N`) with its first bytes, so the archive's table of contents was never found; Wicaby now notices
  and asks for the end of the file by offset.
- Music, on desktop, Android TV and mobile: an album whose cover only shows once a track plays (Emby keeps no cover
  for an album whose art is embedded in its tracks) now shows its first track's art in the library. An artist without
  an image borrows one of its albums' covers. Each is looked up once, a few at a time, and kept for the session; with
  no art at all, a tile shows the initials on a colour from the name.

### Added

- Music library ideas taken from Feishin: an Album, EP, Single or Compilation label, "More by" the artist and a ▶ per
  disc on album pages, similar artists on artist pages, and a tint from the cover (desktop, Android TV and mobile).
  On desktop: play next and add to queue on album cards, a full-size cover, `Ctrl`/`Shift`-click selection with a bar
  and drag onto the queue or a playlist, playlists in the sidebar, covers and extra columns in Songs, an album link and
  remaining time in the bar, a crossfade, format badge and "Similar" tab in the full-screen player, and the shortcuts
  `Ctrl` + `L` (the playing track's album) and `Ctrl` + `Alt` + `→`/`←` (next or previous album in the queue). On
  Android mobile, long-press to select tracks on an album page.

### Changed

- Desktop: the Servers page is now **Sources**, one list of your Emby, Jellyfin and Plex servers, folders and shares,
  and photo sources, with remote access on the same page. **Add Source** opens a sheet that picks the kind of source
  (Emby or Jellyfin, Plex, a folder or share, photos, or a device reached through Tailscale or NetBird) and lists the
  servers found on this network.

## [0.10.3] - 2026-10-14

Photo libraries from your own files. Windows and Linux desktop **0.10.3**, Android TV app **0.10.3** (`versionCode`
24), Android mobile app **0.10.3** (`versionCode` 21).

### Added

- Photo sources from a folder, an SMB share or a WebDAV server, on desktop, Android TV and mobile: **Settings > Photo
  sources** offers "Folder on this computer" (a folder picked with the system picker on Android), "SMB share" and
  "WebDAV" next to Immich. Wicaby indexes the photos once (date, orientation, camera and, only with the map on,
  location from their EXIF), then re-reads only the files that changed; folders become albums. The timeline, grid,
  viewer, slideshow, albums, favourites and "On this day" work as with Immich. Thumbnails are made on demand and cached.

### Fixed

- Android TV and mobile: a photo source's thumbnails no longer load the whole photo into memory (up to 64 MB each,
  several at once). The file is streamed and decoded straight at the thumbnail's size, with a 20 s limit per
  thumbnail and at most two at once on TV (three on phones), so an 8000x6000 photo costs a 500x375 bitmap in the grid.

### Changed

- Android TV and mobile: a comic cover that cannot be read from the archive now leaves one line in the system log (tag
  `WicabyComicCover`): the error and, for each request, the HTTP status, the Content-Range numbers and the bytes read;
  a book skipped for its format or a server cover is logged once per session with its extension. The line never holds
  the address, the book or the token.

## [0.10.2] - 2026-10-14

Music and trailer fixes on Android, playback info. Windows and Linux desktop **0.10.2**, Android TV app **0.10.2**
(`versionCode` 23), Android mobile app **0.10.2** (`versionCode` 20).

### Added

- Android TV: an artist opens their page, as on desktop and mobile, instead of playing at once: their art over the
  backdrop, **Play** and **Shuffle** (focus starts on Play), then rows of albums, **Singles & EPs** and **Appears on**.
  OK on an album opens the album page; Back returns to the artist.
- Android TV and mobile: **Playback info** is now a top-level entry (a column of the TV player's track menu, an (i)
  button in the mobile player's top bar) instead of a toggle inside "Sync…". The panel catches up with the desktop
  overlay: direct play, direct stream or transcode with the server's reasons in plain words, video level and bit depth,
  audio sample rate, subtitle format, and the server with its path (local network, remote or mesh); larger text on TV.

### Fixed

- Android TV and mobile: music played nothing on Emby (the server answered 400 to every track). The stream now carries
  the app's device id and a play session id, as desktop and the video player do, and the track's own media source id
  (an Emby source id is not the item id): the music lists now ask the server for it. The Playing, Progress and Stopped
  reports carry the stream's play session id.
- Android TV and mobile: a video no decoder of the device can play (a VC-1 trailer, for one) no longer plays as sound
  over a black screen: the server converts it, as after a decoder error. ExoPlayer drops such a track without an
  error, which is why the TV showed nothing.

## [0.10.1] - 2026-10-13

LAN services through the VPN, TV fixes. Windows and Linux desktop **0.10.1**, Android TV app **0.10.1** (`versionCode`
22), Android mobile app **0.10.1** (`versionCode` 19).

### Added

- qBittorrent and WebDAV away from home, on desktop: Wicaby connects directly first and, when the home-network address
  doesn't answer within 1.5 s, goes through its own Tailscale/NetBird connection, provided the host is a device of your
  network or sits inside a NetBird network route. **Test Connection** says which way worked ("Connected (direct)" or
  "Connected via NetBird/Tailscale") or which step failed. See [Remote access](docs/remote-access.md).
- Android TV and mobile: NetBird network routes. Hosts inside a route (the home network behind a routing peer) are
  tried directly first, then through Wicaby's own NetBird connection; qBittorrent works that way too.

### Fixed

- Android TV: on a series page, the seasons row keeps its own scroll rule, so moving through the seasons with the D-pad
  never shifts the row by the page's scroll or strands the focus. 0.10.0 already shipped this; a test now guards every
  row of the page.
- Android TV and mobile: qBittorrent through the mesh no longer fails its CSRF check (the headers named the local
  forwarder instead of the configured address).

## [0.10.0] - 2026-10-13

Plex Live TV, Immich and music extras. Windows and Linux desktop **0.10.0**, Android TV app **0.10.0** (`versionCode`
21), Android mobile app **0.10.0** (`versionCode` 18).

### Added

- Plex Live TV and DVR, on desktop, Android TV and mobile: the guide, tuning a channel, recordings, and recording or
  cancelling a series, in the same Live TV screens as Emby and Jellyfin. The section shows only when the server owner
  has a Plex Pass and a DVR with a tuner. It follows Plex's public documentation and has not yet been tried with a real
  Plex tuner.
- Immich as a photo source, on desktop, Android TV and mobile: connect a server with its address and an API key
  (Immich 2.0 or later). Its photos form their own library next to those from Emby or Jellyfin, with the timeline,
  albums (shared ones marked), People, memories and, on desktop, the map. A permission the key lacks hides that part
  and says which one. The key stays encrypted on the device (the vault on desktop, the Android Keystore on Android)
  and is only sent to that server, in a header.
- Music:
  - Desktop: a mini player (`Ctrl` + `Shift` + `M`), a small always-on-top window that reopens where you left it.
  - Desktop and Android mobile: an equalizer with Flat, Bass, Vocal and Treble presets, 10 bands and a preamp. Flat adds
    no filter, so bit-perfect output stays bit-perfect; on Android it is off, and says why, during passthrough.
  - Android Auto (the Google Play build): Recent, Playlists, Albums and Artists to browse in the car.
  - Lyrics from LRCLIB (lrclib.net) when the server has none, **off by default** (Settings, Audio on desktop;
    Settings on the phone). When on, it sends the song's artist, title, album and length, and keeps the answer for 30
    days.
- README: screenshots of Photos, Music and Plex. Every screenshot shows the same frozen moment and carries no metadata;
  `npm run checks` fails on an image that does.

### Fixed

- Comic covers on Emby: covers taken from the book itself show again (Emby's longer Range answers were refused).
- Android mobile: NetBird browser sign-in works; a failed connection to the management server names the step that
  failed, and on Android 17 a management server on the local network asks for the local network permission.

## [0.9.0] - 2026-10-13

Plex on Android TV and mobile. Windows and Linux desktop **0.9.0**, Android TV app **0.9.0** (`versionCode` 20),
Android mobile app **0.9.0** (`versionCode` 16).

### Added

- Android TV and mobile: Plex servers, as on desktop. Wicaby is an unofficial client, not affiliated with Plex.
  - Link a Plex account with a code (plex.tv/link or a QR code), no password form. Your servers and the ones shared
    with you are added; shared servers show by default and each one can be hidden. Plex Home profiles appear in
    "Who is watching?", and a protected profile always asks for its PIN.
  - Connections: local addresses first, then remote, then Plex's relay (with a badge). Servers that require secure
    connections are never reached over http; an unencrypted local address gets your Plex access only after you
    confirm it. Tokens are kept in the Android Keystore-backed storage, never in an address.
  - Browse, play and resume through the server's decision (direct play or HLS from the resume point), multi-part
    films as one queue, track choices saved to Plex, progress reported once, Skip intro from Plex markers and BIF
    trickplay. The plex.tv watchlist shows as Favorites.
  - Mobile: downloads only when the server allows them, otherwise Wicaby says why.
  - For the server owner, "Refresh metadata". Admin, Live TV, casting and "Play on" are not available on Plex
    servers on Android.
  - Plex Pass gates are detected and explained, never worked around.
- The Android Plex mapping passes the same test vectors as desktop.

## [0.8.0] - 2026-10-13

Plex on desktop. Windows and Linux desktop **0.8.0**, Android TV app **0.8.0** (`versionCode` 19), Android mobile app
**0.8.0** (`versionCode` 15).

### Added

- Desktop: Plex servers, next to Emby, Jellyfin and file sources. Wicaby is an unofficial client, not affiliated
  with Plex.
  - Link a Plex account with a code (plex.tv/link or a QR code), no password form. Your servers and the ones shared
    with you are added; shared servers show by default and each one can be hidden. Plex Home profiles appear in the
    profile picker, and a protected profile always asks for its PIN.
  - Connections: local addresses first, then remote, then Plex's relay (with a badge). Servers that require secure
    connections are never reached over http; an unencrypted local address gets your Plex access only after you
    confirm it. The account token goes only to plex.tv, and each server's token stays in the vault.
  - Browse: Plex's own Home rows, libraries, search, shows, editions, Continue Watching, Up Next, playlists,
    collections, the plex.tv watchlist as Favorites, music in the music player and photos in Photos.
  - Playback through the server's decision (direct play or HLS from the resume point), multi-part films as one queue,
    track choices saved to Plex, progress reported once, Skip intro from Plex markers, BIF trickplay, and casting to
    a Chromecast or a DLNA TV through the relay.
  - For the server owner, "Refresh metadata". The Admin panel, Live TV, "Play on", mix and radio, subtitle search
    and comics are not available on Plex servers.
  - Plex Pass gates (remote playback, Live TV, intro detection, hardware transcoding) are detected and explained,
    never worked around.
- About: "unofficial client, not affiliated with Plex", and a Plex entry in the third-party notices.

### Fixed

- Android TV: music stops when the profile picker locks at startup and on sign-out.


## [0.7.0] - 2026-10-13

Music. Windows and Linux desktop **0.7.0**, Android TV app **0.7.0** (`versionCode` 18), Android mobile app
**0.7.0** (`versionCode` 14).

### Added

- All platforms: a full music player for Emby and Jellyfin music libraries.
  - Albums, artists (with an "album artists only" toggle), songs, genres and playlists; album pages with disc
    headers, artist pages with top songs and the discography split into albums and "appears on".
  - A queue you can edit while it plays: play next, add to queue, move, remove, clear upcoming, shuffle (turning
    it off restores the order), repeat all or one, and save the queue as a playlist.
  - Mix and radio from a song, album, artist, genre or playlist, through the server's instant mix. Radio tops the
    queue up as it runs low.
  - Favourites, add to playlist and go to artist or album from every track's menu.
  - Synced lyrics from the server, when it has them (click a line to jump there on desktop).
  - Loudness: ReplayGain in album mode by default, with the server's gain for untagged files and a preamp.
- Desktop: music plays through mpv with no window, audio only: gapless playback, ReplayGain, and bit-perfect
  output with WASAPI exclusive mode. A now-playing bar, a queue panel, a full-screen player with lyrics, music
  keyboard shortcuts (editable in Settings), media keys and Windows media controls. The queue comes back,
  paused, at the next start. The built-in player stays as a simpler fallback (no gapless, no ReplayGain tags).
- Android mobile: a music section with a mini player, a full-screen now playing with lyrics and the queue, and
  lock-screen and notification controls.
- Android TV: music rows (recent albums, recently played, playlists, artists, genres), a now-playing screen
  built for the remote with queue editing, music that keeps playing after Home or Back, and an ambient view after
  2 minutes without a key, also shown by the screensaver while music plays.

### Changed

- Android TV: the basic music views of 0.4.1 grow into the new music player.

## [0.6.0] - 2026-10-13

File sources. Windows and Linux desktop **0.6.0**, Android TV app **0.6.0** (`versionCode` 17), Android mobile
app **0.6.0** (`versionCode` 13).

### Added

- All platforms: file sources. Browse and play videos straight from a folder, a WebDAV server (Nextcloud,
  Synology, QNAP, TrueNAS, `rclone serve webdav`…) or an SMB share, next to your Emby and Jellyfin servers,
  with no server and no scan.
  - Folders first, then videos, in natural order (`E2` before `E10`), sortable by name, date modified or size.
  - Titles, years and episode numbers from the NFO file when there is one, otherwise from the file name;
    posters, backgrounds and subtitles from the files next to the video.
  - Playback progress is kept on the device, with a Continue row for files. A file that changed since you
    last watched it starts again from the beginning.
  - "Show file sources on Home" (off by default) adds files in progress to Home's Continue Watching.
  - "Find on this network" lists WebDAV and SMB servers that announce themselves (mDNS). A reply only fills
    the form; nothing connects until you press Test.
  - Self-signed WebDAV certificates: Wicaby shows the fingerprint and trusts it for that source only after
    you accept it, and warns if it changes. A plain `http://` address needs an explicit acknowledgement.
  - Passwords are kept in the app's encrypted storage and never appear in logs, addresses or settings
    exports.
- Desktop: a Files section in the sidebar, folders picked with the system dialog, WebDAV through a local
  relay (the player never sees the password), and SMB shares by their `\\STORAGE\media` path on Windows, with
  your Windows session credentials. SMB is not available on Linux yet.
- Android TV: a Files tab with a folder grid built for the remote. Sources are added in Settings.
- Android mobile: a Files section in Libraries, with local folders from the system picker.
- Android: SMB 2 and 3 shares through a small gateway in the built-in network library (go-smb2).

### Changed

- The apps now decide what to show per source type (Admin, Live TV, casting, favourites, transcoding…) from
  one table of capabilities, which the Plex support will reuse.

## [0.5.1] - 2026-10-13 (Android)

Android only: Android TV app **0.5.1** (`versionCode` 16), Android mobile app **0.5.1** (`versionCode` 12). The
desktop stays at 0.5.0.

### Fixed

- Android TV: in a photo library, OK on the Albums or Favourites tab could send the focus to the top bar and
  open Home. The tab buttons now stay on screen while a tab loads, and the selected one is marked in the accent
  colour.
- Android TV: Up from the top of a library page moved to the Home tab instead of that library's tab.
- Android TV: the Memories screensaver asks the server for at most 30 photos per year.

## [0.5.0] - 2026-10-12

Photos. Windows and Linux desktop **0.5.0**, Android TV app **0.5.0** (`versionCode` 15), Android mobile app
**0.5.0** (`versionCode` 11).

### Added

- All platforms: Emby and Jellyfin photo libraries (and home-video libraries) open in a Photos timeline with
  Timeline, Albums and Favourites tabs, month headers, and video clips with their duration.
- All platforms: a photo viewer with zoom, previous and next, favourite, and an info panel with the date
  taken, camera, exposure, dimensions and, when the photo has one, its position. Videos play in the player.
- All platforms: a slideshow with a fade and an optional Ken Burns effect, a choice of interval, and the
  screen kept awake while it runs.
- All platforms: an "On This Day" row on the home screen with photos taken on today's date in earlier years.
- Desktop: a justified, virtualised timeline with three thumbnail sizes, a date scrubber, keyboard
  navigation, a shuffle order for the slideshow and "Save original".
- Desktop: an optional photo map, off by default. Turn it on in Settings > Privacy & Storage; it fetches
  OpenStreetMap tiles through the app, with the attribution shown, and the tile address can be changed.
  Places are never looked up by name.
- Android mobile: pinch between three thumbnail sizes, a fast scroller, swipe through photos, swipe down to
  close, and long-press to select photos for a slideshow or favourites.
- Android TV: a photo grid built for the remote (Page or Channel +/−, or hold Down, to change month), and a
  screensaver that can show your photos, one album or "On This Day" in place of the film artwork, which stays
  the default.

## [0.4.4] - 2026-10-12

A welcome wizard and a Remote access settings page. Windows and Linux desktop **0.4.4**, Android TV app
**0.4.4** (`versionCode` 14), Android mobile app **0.4.4** (`versionCode` 10).

### Added

- All platforms: a short welcome wizard on first launch: language (System, Français, English), look (Dark or
  OLED, accent color), where the server is (this network, an address, or remote access), sign-in, a few
  optional extras, and a summary of the servers and the remote-access device. Every step can be skipped and
  each choice is saved at once; Settings > Run Setup Again opens it again. Existing installs skip it.
- All platforms: a Remote access settings page: status and last error, this device's name and address, the
  devices on your network (online first), routed networks, sign out or switch between Tailscale and NetBird,
  and Copy Diagnostics with addresses, keys and codes hidden. "Find Servers" probes the online devices for a
  media server, only when asked. On the desktop, the sidebar connection popover links to it and an installed
  Tailscale or NetBird app shows under Advanced; on Android TV, the diagnostics are shown as a QR code.
- Android mobile: several servers at once, as on the TV and the desktop: Settings > Other Servers adds or
  removes one, and Home, Libraries and Search merge them.
- Android mobile: OLED (pure black) theme.
- Android TV: a setting to hide the Wicaby rows from the launcher's home screen.

## [0.4.3] - 2026-10-12

Playback robustness, address switching and a smoother player exit. Windows and Linux desktop **0.4.3**,
Android TV app **0.4.3** (`versionCode` 13), Android mobile app **0.4.3** (`versionCode` 9).

### Added

- Android TV and mobile: Settings > Server addresses: a local and a remote address per server, learned from
  the server or typed in. Wicaby uses the one that answers and switches when the network changes.
- Desktop: after a wake from sleep or a network change (another Wi-Fi, a cable, a VPN up or down), each
  signed-in server is probed and moves to whichever of its addresses answers, with its session; a server
  that was unreachable at startup comes back once it answers. Nobody is signed out.

### Changed

- Desktop: leaving the player no longer flashes the desktop. Playback pauses, the picture fades to black
  and uncovers the item page, which stays mounted with the focus back on Play; entering fades in on the
  first frame. Reduced motion gives an instant switch.

### Fixed

- Android TV and mobile: a direct play the device cannot open or decode is retried once with the server
  converting it ("Switching to server conversion…"); after an out-of-memory error (a 4K remux on a TV
  with a 192 MB heap), at 20 Mb/s.
- Android TV and mobile: a dropped stream reloads at its position with backoff ("Reconnecting…") instead of
  ending on an error; the error screen has a Retry and no longer leaves a session open on the server.
- Desktop: a stream that errors, ends early or stalls reopens at its position with backoff while the
  server is probed ("Reconnecting…", with Retry after a minute); a direct-play file that fails to open or
  decode is retried once with a server transcode.
- Android TV and mobile: Home rows set to thumbnails before 0.4.3 show as posters again (a stale setting kept
  a Latest row in thumbnails); the order and hidden rows are kept.

## [0.4.2] - 2026-10-12

Quick fixes from the Plezy issue triage and the first Infuse-inspired ideas. Windows and Linux desktop
**0.4.2**, Android TV app **0.4.2** (`versionCode` 12), Android mobile app **0.4.2** (`versionCode` 8).

### Added

- Desktop: hold the Seek forward key (→) or the mouse button on the picture to play at 2×; letting go
  restores the speed. Not for live TV or while audio is sent as a bitstream.
- Android TV and mobile: audio delay (50 ms steps) and subtitle offset (100 ms steps) in the player's
  Audio and subtitles menu, under "Sync…". Remembered per video; "Whole series" carries them to the other
  episodes. The audio delay also works with HDMI passthrough.
- Android TV and mobile: a playback stats panel (container, codecs, decoder, HDR, bitrate, play method and
  transcode reason, buffer, dropped frames), turned on from the same "Sync…" sheet.

### Fixed

- Android TV and mobile: the video buffer is capped by the device's memory (16 to 128 MB) instead of Media3's
  ~130 MB default, which could crash 32-bit TVs on high-bitrate files; the live TV 16 MB cap now applies too.
- Android TV and mobile: speeds other than 1× are disabled, with the reason, while the audio goes out as
  HDMI passthrough (the speed did not apply there).
- Android TV: the remote's fast-forward and rewind keys step 10 s like ←/→ instead of jumping whole chapters.
- Android TV and mobile: https servers behind a private CA work once its root CA is installed on the device
  (user-installed CAs are trusted; Tailscale and NetBird stay on the system store).
- Android TV and mobile: Home and Continue Watching reload on return from the player or another app, after a
  server change (UserDataChanged, LibraryChanged) and every 5 minutes while on show.
- Android TV: a shuffle plays every entry from the start instead of its resume point.
- Android TV and mobile: "Open in an external player" passes the external subtitle files (MX Player, Vimu, VLC).
- Android TV: clearing "watched" removes only the latest play from the Trakt history instead of every play;
  removing an entry from the History screen does the same.
- Android mobile: the player follows the system rotation lock.
- Android TV and mobile: the next episode skips specials unless the server places them by air date.
- Desktop: the display may sleep while playback is paused (VOD; a paused live channel only keeps the app
  awake for its timeshift). It is blocked again on play, also after the sleep timer's pause.
- Desktop: audio and subtitle languages follow the server user's preferences by default instead of French;
  settings still holding the old untouched defaults move over once. A film remembers its audio and subtitle
  pick on resume.
- Desktop: interlaced recordings, DVD rips and 1080i TS are deinterlaced (mpv `deinterlace=auto`; Linux
  needs mpv 0.39 or later).
- Desktop: mpv no longer registers its own Windows media session next to Wicaby's.
- Desktop: Enter skips the intro even when a player button kept focus after a mouse click.
- Desktop: a subtitle delay no longer carries over to the next episode unless its memory is set to "Per Title"
  (Settings > Playback).
- Desktop: refresh-rate matching picks 23.976 Hz for 23.976 fps (and 59.94 Hz for 29.97 or 59.94 fps)
  when the display offers it, instead of 24 or 60 Hz.

## [0.4.1] - 2026-10-12

One version for every app: Windows and Linux desktop **0.4.1**, Android TV app **0.4.1**
(`versionCode` 11), Android mobile app **0.4.1** (`versionCode` 7). Everything since 0.3.1 is
summed up here; the desktop hotfixes 0.3.2 to 0.3.4 keep their own entries below.

### Added

- Linux desktop (x64 `.deb`, AppImage and `.tar.gz`, SDR only), playing through the
  distribution's mpv 0.37 or later. Desktop integration: media keys and media controls through
  MPRIS, launch at login through an XDG autostart entry, notifications (a click replaces the
  action buttons Linux notification servers do not show), refresh-rate matching with `xrandr`
  (X11) or `kscreen-doctor` (KDE Plasma on Wayland). Windows-only settings (Windows HDR, HDR
  passthrough) are hidden on Linux and the texts that named Windows follow the platform.
- Android TV parity with the desktop app (logic in `:core`, so the phone app can reuse it):
  - night mode, dialogue enhancement, loudness normalization and a volume boost to 150 %, in
    Settings and from the player's Audio Effects sheet;
  - subtitle styling as on desktop (size, font, color, legibility, position, optional ASS
    scaling), and Dark or OLED (pure black) themes with eight accent colors;
  - shuffle and a play queue, with "Play next" and "Add to queue" from "Play on";
  - item actions: "Add to Playlist…", "Add to Collection…" and "Mark Previous Episodes as
    Watched";
  - several servers at once, merged in home rows, search and libraries ("Available on 2
    servers"); a server that stops answering is left out and comes back on its own;
  - customizable home rows, with posters or thumbnails for Recently Added;
  - watch history and statistics across every signed-in server, with the desktop's queries;
  - "Who's Watching?" profiles at start and from "Switch User", with an optional PIN;
  - parental access schedules: refusals outside the allowed hours show today's hours, on Emby
    and Jellyfin, at sign-in and for a saved account;
  - Trakt: device-code sign-in, scrobbling and watched sync, per server;
  - voice search for Live TV channels and programmes.
- Android TV: an A–Z jump rail beside library grids sorted by name. LEFT from the first column
  opens it on the current title's letter, UP/DOWN scroll the grid live, OK or RIGHT jumps to the
  letter's first title, BACK returns. The server counts where each letter starts, so a jump lands
  anywhere in a large library without loading it.
- Android TV: basic music. Music libraries show albums, artists and songs; an album, artist,
  playlist or song plays all its tracks as a queue, with the album art full screen, the queue
  position and the next track, and the media keys play, pause and skip. A fuller music player is
  planned.
- Comics: the first page is the cover when the server has none (desktop, TV and mobile), read
  with HTTP range requests, never the whole archive.
- Mocks and checks: Trakt, public users and profiles, per-user access schedules, watch history,
  a small silent music library, A–Z name bounds and comic covers.

### Fixed

- Android TV, security: the PIN of a "Who's Watching?" profile could be bypassed. Until the picker
  has opened an account the TV now has no session at all: no server socket or remote control,
  and launcher rows (Watch Next, channels), reminders, the screensaver and "Play" sent from
  another app wait or do nothing; "Switch User" cannot be left with Back. PIN tries are
  rate-limited (after 5 wrong tries each try waits, from 30 s up to 1 h).
- Android TV: D-pad RIGHT on the last card of a row or grid (LEFT on the first) no longer jumps to
  another row or the tab bar.
- Android TV and mobile: admin messages show in an in-app banner, browsing or playing, and as a
  toast while the app is in the background. Mobile showed them only during playback; with "Allow
  remote control" off, both apps dropped them.

## [0.3.4] - 2026-10-12

Windows desktop app.

### Added

- Connection status on the sidebar dot: green, orange or red for all connections, and a popover
  (hover or keyboard focus) with each signed-in server (state, address, local / remote / VPN route,
  latency, realtime socket), the VPN (node, mesh IP and name, NetBird routed networks) and
  qBittorrent. Each row opens its settings pane.

### Fixed

- Admin messages ("Send a message" from a server dashboard) show during mpv playback: the player
  window shows notifications, which went to the hidden main window before. They also show with
  "Allow remote control" off (a message is not remote control) and stay up for the sender's
  timeout (3 to 30 s).

## [0.3.3] - 2026-10-12

Windows desktop app and mesh helper.

### Added

- NetBird network routes on Windows: a server in a network a NetBird peer routes (for example the
  home LAN behind a routing peer) is reached through NetBird when it does not answer directly.
  Exit nodes (default routes) are never used.

## [0.3.2] - 2026-10-12

Windows desktop app hotfix.

### Fixed

- NetBird: a self-hosted management server typed in "Self-Hosted NetBird Server or Setup Key" is
  used. The button no longer reopens the earlier login.netbird.io page; it connects with the server
  and key in the fields, the node restarts on it, and a registration made with another server is
  dropped so the sign-in starts afresh. The saved server shows in the field.
- Home loads faster: each row appears as soon as its own answer arrives instead of waiting for
  every other row, and a saved server that is unreachable no longer restarts the loading.
- Home no longer breaks (and could not be reopened) when a server lists the same item twice; a
  row that fails leaves the rest of the page working. Repeats are also dropped in library pages
  and in cast and crew lists.
- No more "An object could not be cloned" error during playback when the Cast list updates, nor
  when removing a second card from Continue Watching.

## [0.3.0] - 2026-10-12

Android TV app **0.3.0** (`versionCode` 8), Android mobile app **0.3.0** (`versionCode` 4).

### Added

- Cast everywhere: one Cast button on Windows and on phones, with a
  picker in three sections (apps, DLNA/UPnP TVs and players, Chromecast and Google TV), a
  remote while casting and "Play here" to take playback back. AirPlay is not supported.
- "Play on" through the Sessions API: Windows and phones send to any Wicaby, Emby or Jellyfin
  session, including the DLNA renderers the server exposes; the phone app now also receives,
  with a notification when it is in the background.
- DLNA/UPnP sender on Windows (with a LAN stream relay, so the TV never gets the access token)
  and on phones, with SSDP discovery and Sony and Samsung quirks.
- Desktop: Chromecast and Google TV over the open CASTV2 protocol, with Jellyfin's receiver app
  for Jellyfin and the Default Media Receiver (with VTT subtitles) for Emby.
- Android mobile: a `gplay` flavour (`Wicaby-Mobile-Cast-*`) with Google Cast through Google
  Play services and Media3 `CastPlayer`; it has no FFmpeg audio decoder. The default `foss`
  flavour keeps FFmpeg and contains no Google code.
- A disposable Jellyfin token per cast through Quick Connect, revoked when the cast ends.
- Mocks and checks: Sessions-API remote control, DLNA renderers (generic, Sony, Samsung) and a
  CASTV2 device, all on loopback.

### Changed

- Licence: one identifier, GPL-3.0-or-later, plus a section 7 additional permission for linking
  with Google Play services in the `gplay` flavour only (`LICENSE-EXCEPTION.md`).

### Fixed

- Android 17: Wicaby declares and requests the local network permission, so LAN servers,
  discovery and casting keep working; remote servers work without it.
- Desktop: the "Play on" receiver validates every remote command, and an "Allow remote control"
  setting turns it off.

## [0.2.0] - 2026-10-11

First public release. Android TV app **0.2.0** (`versionCode` 7), Android mobile app **0.2.0**
(`versionCode` 3).

### Added

#### Desktop (Windows)

- Windows media client for Emby and Jellyfin, rewritten from Emby Theater: Electron main
  process with a typed IPC contract, Svelte 5 UI, `mpv` playback in a child process with a video
  window and a transparent on-screen display, and an HTML5 / hls.js fallback player.
- Server discovery on the LAN, Emby Connect, Wake-on-LAN, remote control, taskbar thumbnail
  buttons, jump list, media keys (SMTC) and refresh-rate matching.
- Resumable offline downloads.
- Multi-server: several Emby and Jellyfin servers signed in at once, with a merged home and
  search, provider-id de-duplication with a server chooser, a sidebar grouped per server and
  per-server sign-in and sign-out.
- Browse pages: hero carousel, shelves, an Apple TV-style item page and cached navigation.
- Live TV with a guide and recordings, playlists and collections, and a customisable home.
- Skip intro and credits (Emby chapter markers, Jellyfin media segments), next-episode card,
  "still watching?" prompt, trickplay thumbnails on the scrubber (BIF and Jellyfin tile sheets)
  and a chapter picker.
- Playback engine: an mpv watchdog that falls back to the HTML player at the same position,
  reconnects and larger caches for remote servers, audio passthrough, volume boost up to 150 %,
  night mode and dialogue boost, one track-selection engine (forced tracks, per-series memory),
  and subtitle styling with Geist through libass.
- HDR10, HDR10+, HLG and Dolby Vision in mpv: tone mapping with peak detection on SDR
  displays, passthrough once mpv reports an HDR output, Dolby Vision reshaping through
  libplacebo, and an optional Windows HDR auto-switch that restores the previous state on stop
  or after a crash.
- Aspect modes (fit, fill, stretch, zoom, original), trailers (local trailers, and YouTube
  through the privacy-enhanced `youtube-nocookie.com` embed), an optional cinema mode, and
  Dolby Vision / HDR10+ / HDR10 / HLG chips per version on the item page.
- CBZ comic reader with manga right-to-left and webtoon modes driven by `ComicInfo.xml`, spreads,
  and progress saved to the server.
- Remote access: detects and drives installed Tailscale and NetBird clients, or runs Wicaby's
  own embedded mesh node (see Mesh below).
- qBittorrent integration (Web API v2, qBittorrent 4.x and 5.x): live list, actions, add by
  magnet link or `.torrent` file, and library mapping that triggers a library scan when a
  download completes.
- Server administration for server administrators: dashboard with live sessions and remote
  control, activity log, scheduled tasks, users and policies, devices, libraries with a
  server-side folder browser, item metadata, images, identify, subtitles and delete, server and
  network settings, transcoding, plugins, API keys and logs, for both Emby and Jellyfin.
- Windows integration: tray icon with a mini player, start with Windows, close to tray and
  notifications.
- Much richer settings: density, poster size, zoom, quality per network, resume behaviour,
  audio device, privacy, advanced options and search.
- English and French UI: per-namespace catalogues, live language switch, `Intl` formatting, a
  glossary and a strict catalogue checker (`tools/checks/i18n-check.mjs --strict`).
- New logo (a W with a blue play triangle) rolled out to the Windows icons, the in-app logo,
  and a monochrome variant for the sidebar.

#### Android TV

- Wicaby for Android TV (Kotlin, Compose for TV, Media3): server add and discovery, profile
  picker and sign-in, home with hero and rows, libraries, item pages with seasons, search, and
  settings with an accent colour.
- A device profile built from the device's decoders (sizes, profiles, levels, HDR and Dolby
  Vision capabilities, with known-broken devices excluded); passthrough re-read for every
  playback; display-mode switching.
- FFmpeg audio decoding (AC-3, E-AC-3, DTS, TrueHD and more) and full ASS/SSA subtitle styling
  through libass; image subtitles burned in when transcoding.
- Skip intro, next episode, and the Android TV "Watch Next" row.
- tvOS-style floating top bar, exit confirmation, sectioned settings, a Torrents tab and
  remote access with QR-code sign-in.
- English and French, with an in-app language picker (per-app locales on Android 13+).
- CBZ comic reader (D-pad, spreads, right-to-left, webtoon).
- Version picker for multi-source items, used by playback information, streams and downloads.
- In-app updates for sideloaded APKs from an `update.json` manifest, on by default and pointing
  at the public releases page. The APK's SHA-256 is checked whenever the manifest lists one
  (the published manifests always do), and installation goes through `PackageInstaller`.
- Fit, fill, stretch and zoom in the player; trailers (YouTube opens externally or as a QR
  code); Dolby Vision (with profile), HDR10+, HDR10 and HLG badges.
- A universal APK alongside the per-ABI APKs, for 32-bit Android TVs.

#### Mobile (Android phones and tablets)

- Wicaby for phones and tablets: a Material 3 app in the Graphite style with an adaptive
  navigation bar or rail, gesture player, picture-in-picture, background playback, offline
  downloads and torrents.
- Shared `:core` module (UI-free) with the TV app, and a shared `:mesh-ui` remote-access panel.
- English and French with an in-app language picker; CBZ comic reader (swipe, pinch to zoom).
- Version picker, in-app updates, aspect modes, trailers and HDR / Dolby Vision badges, as on
  TV.

#### Mesh (`packages/mesh`)

- `wicaby-mesh`, an embedded Tailscale (`tsnet`) or NetBird (`client/embed`) node written in
  Go. It runs in userspace, needs no installation or administrator rights, and shows up in the
  tailnet or NetBird network as its own node.
- Each media server is reached through a loopback-only forwarder
  (`http://127.0.0.1:<port>/<random token>`) that only dials current peers of the mesh.
- A gomobile AAR for Android (arm64-v8a and armeabi-v7a) with Android network-interface
  listing.
- The build scripts collect every linked module's licence into `THIRD_PARTY_LICENSES.txt` and
  fail if any AGPL NetBird package (`management/`, `signal/`, `relay/`, `combined/`) is linked.

### Changed

- Repository reorganised into a monorepo: `apps/desktop` (Electron), `apps/android` (Gradle root;
  the Android TV module `:app` is renamed `:tv`, application ids unchanged so installed apps keep
  updating), `packages/mesh` (Go), `tools/mock-server`, `tools/checks` (one runner:
  `npm run checks`), `tools/release`, `brand` and `docs/`. The root `package.json` is an
  npm workspaces root that delegates `dev`, `start`, `build`, `check` and `dist` to
  `apps/desktop`.
- Added `.editorconfig`, `.gitattributes` (LF for sources, CRLF for PowerShell and batch
  scripts) and `.nvmrc` (Node 22).
- Licensed under GPL-3.0-or-later, with `THIRD_PARTY_NOTICES.md`, `CONTRIBUTING.md` and `SECURITY.md`.
<!-- TODO: add the dependency upgrades (Electron, Svelte/Vite, Media3, Compose, Go modules, mpv)
     here once they are merged, before tagging v0.2.0. -->
- Desktop: Graphite design system (Apple-style tokens, Mica sidebar, view transitions, GPU-only
  motion), redesigned shell and onboarding with a profile picker, and a redesigned player OSD,
  settings and downloads.
- Desktop: neutral, static, monochrome icons across browse, settings and the OSD; no accent-,
  pink- or yellow-coloured glyphs and no coloured squares behind settings icons.
- Desktop: the blue focus ring is gone; focused controls show a fill or a lift instead.
- Desktop: calm sidebar with a static fill on the active row and no fade on hover or selection;
  the window chrome switches instantly and only the page cross-fades during navigation.
- Desktop: neutral palette everywhere, audio and subtitle delay readouts, and the formal "vous"
  form in the French UI.
- Desktop: Jellyfin uses the modern `/User*` routes; Emby keeps its own.
- Desktop: GET responses from the server are cached for two minutes, so going back is instant.
- Desktop: a user-supplied `mpv.conf` now really wins when "Use mpv.conf" is on, including over
  the audio output.
- Android: release APKs are split per ABI (about 55 MB instead of 175 MB).

### Fixed

- Desktop: black video in mpv. Chromium composites a window's own surface above its child
  windows, so the mpv host is now a transparent window; `nvdec` maps to `nvdec-copy` with
  `d3d11va` and software fallbacks.
- Desktop: a 401 response no longer signs the user out unless `GET /Users/{id}` confirms the
  token is no longer valid.
- Desktop: title-bar search; the search page follows `?q=` without remounting.
- Desktop: aborted view transitions no longer break the router.
- Desktop: two selected sidebar rows briefly drawn at once during page transitions.
- Desktop: a vetoed quit no longer leaves close-to-tray disabled.
- Desktop: when the audio device refuses passthrough (for example TrueHD to plain speakers),
  mpv no longer waits forever; Wicaby clears `audio-spdif` and reopens the track as PCM.
- Desktop: both playback windows realign after any move, resize or display change, and mpv is
  nudged when its render size disagrees with the host window.
- Desktop: Jellyfin 12 compatibility (the WebSocket token is passed as `ApiKey`).
- Desktop: on Jellyfin, Next Up no longer lists items that are already in Continue Watching.
- Android: JSON decoding is lenient, so Emby's numeric Studios ids no longer break item pages
  ("Impossible de charger le contenu").
- Android: text fields stay above the on-screen keyboard, and the login column no longer
  overlaps.

### Security

- Desktop: server access tokens are stored in a vault encrypted with Windows DPAPI (Electron
  `safeStorage`), bound to the Windows user account; Emby Theater kept them as plain JSON.
- Desktop: the renderer runs sandboxed with context isolation and no Node integration, behind
  a Content Security Policy that allows only the app's own scripts (inline styles are allowed); navigation away from the app and new windows are blocked,
  and web permissions are limited to fullscreen and clipboard writes.
- Desktop: server images, streams and subtitles go through the `wicaby-media://` protocol,
  which adds authentication in the main process, so the renderer does not hold the session
  token.
- Desktop: the qBittorrent password is kept in the vault, bound to its host and user; a
  self-signed certificate is accepted only after the user trusts its fingerprint for that host.
- Desktop: the YouTube trailer embed is limited to `youtube-nocookie.com` by a narrow
  `frame-src` rule.
- Android: access tokens are sealed with an AES-GCM key held in the Android Keystore, and app
  backups are disabled.
- Android: downloaded updates are checked against the SHA-256 in the manifest, when it lists
  one, before installation; Android also requires the same signing key as the installed app.
- Mesh: loopback-only forwarders with an unguessable path token and a live peer allow-list;
  secrets reach the helper on stdin, never in its command line or environment; log upload to
  Tailscale is compiled out of the Android library.
- Release: the bundled mpv build is pinned (shinchiro `20261011`, mpv `git-accb7b2821`) and its
  SHA-256 checked on download; a release needs a green CI run on its commit, every APK must be
  signed by the expected certificate, and the workflows' actions are pinned to commit SHAs.
- Release: the Windows app ships its licence texts in `resources/licenses/`, and each release
  publishes the matching mpv source archive next to Wicaby's own.

[Unreleased]: https://github.com/WicaebethTheo/wicaby/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/WicaebethTheo/wicaby-releases/releases/tag/v0.3.0
[0.2.0]: https://github.com/WicaebethTheo/wicaby-releases/releases/tag/v0.2.0
