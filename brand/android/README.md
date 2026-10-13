# Android resources

The generators write straight into the apps, so there is no copy step:

- `brand/scripts/make-brand.mjs` writes the XML files into `apps/android/tv/src/main/res/` and `apps/android/mobile/src/main/res/` (the banner only into `tv`).
- `brand/scripts/make-icon.mjs` (`npm run icon`) renders the legacy PNGs into `apps/android/tv/src/main/res/`.

| File (under `res/`) | Notes |
| --- | --- |
| `drawable/ic_launcher_foreground.xml` | Adaptive foreground on the 108 dp canvas: white W and blue play, about 48 dp wide and centred. It stays inside the 66 dp safe zone. |
| `drawable/ic_launcher_background.xml` | Graphite gradient from `#1C1C1F` to `#0B0B0D`, with `aapt:attr`. Adaptive icons are API 26+, so the gradient is safe. |
| `values/ic_launcher_background.xml` | Flat `@color/ic_launcher_background` (`#141416`). |
| `drawable/ic_launcher_monochrome.xml` | Android 13+ themed-icon layer: the same mark in one colour, with the gap open. |
| `mipmap-anydpi-v26/ic_launcher.xml`, `ic_launcher_round.xml` | `<adaptive-icon>` with background, foreground and monochrome. Hand-written, not generated. |
| `mipmap-{mdpi…xxxhdpi}/ic_launcher.png`, `ic_launcher_round.png` | `tv` only: legacy icons for API 23 to 25 (48 to 192 px). The square one is the app-icon tile and the round one is a graphite disc (source: `legacy-round.svg`, in this folder). |
| `drawable/banner.xml` | `tv` only: launcher banner, 160×90 dp, flat `#141416`, with the mark and the outlined "Wicaby". It has no gradient, so it renders on API 23. |
| `drawable/ic_stat_wicaby.xml` | Notification small icon: 24 dp, white, using the small cut so the gap survives. |
